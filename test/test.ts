import { describe, it, before, after } from "node:test";
import { v4 as uuid } from "uuid";
import * as Y from 'yjs';
import axios from 'axios';
import Redis from 'ioredis';
import knex from 'knex';
import {expect} from "chai";
import { randomInt, randomUUID } from "crypto";
import { createEnv } from 'neon-env';
import { zip } from "lodash";
import { EventEmitter } from "stream";
import logUpdate from 'log-update';

process.on('unhandledRejection', (err) => {
    console.error(err);
})

const log = (key: string, value?: any) => typeof value !== "undefined" ? console.log(`======> ${key}`, value) : console.log(`======> ${key}:`);

const defaults = {
    SERVER_URL: 'http://localhost:3000',
    PG_URL: 'postgres://dev:dev@localhost:5432/k_yrs_dev?sslmode=disable',
    REDIS_URL: 'redis://localhost:6379',
    
    RW_ITERS: 1,
    RW_Y_OPS_WAIT_MS: 0,
    
    COMPACTION_ITERS: 1,
    COMPACTION_YDOC_UPDATE_INTERVAL_MS: 0,
    COMPACTION_YDOC_UPDATE_ITERS: 10000,
    COMPACTION_Y_OPS_WAIT_MS: 0,
    
    CONSISTENCY_ITERS: 1,

    CONSISTENCY_SIMPLE_READTIMEOUT_MS: 0,
    CONSISTENCY_SIMPLE_ITERS: 10000,

    CONSISTENCY_LOAD_TEST_ITERS: 1,
    CONSISTENCY_LOAD_YDOC_UPDATE_ITERS: 10000,
    CONSISTENCY_LOAD_YDOC_UPDATE_INTERVAL_MS: 0,
    CONSISTENCY_LOAD_YDOC_READ_TIMEOUT_MS: 0,
    CONSISTENCY_LOAD_READ_PER_N_WRITES: 10,
} as const;

type ConfigSchema<T> = {
    [K in keyof T]: {
      type: T[K] extends number ? 'number' : T[K] extends string ? 'string' : never;
      default: T[K];
    };
};

function createEnvSchema<T extends object>(obj: T): ConfigSchema<T> {
    return Object.keys(obj).reduce((acc, key) => {
      // Cast key to keyof T for proper type inference
      const typedKey = key as keyof T;
      const value = obj[typedKey];
      let type: 'number' | 'string';
      if (typeof value === 'string') {
        type = 'string';
      } else if (typeof value === 'number') {
        type = 'number';
      } else {
        throw new Error(`Unsupported type for key ${key}`);
      }
      return {
        ...acc,
        [typedKey]: { type, default: value },
      };
    }, {} as ConfigSchema<T>);
  }


const env = createEnv(createEnvSchema(defaults));

log(`env`, env);

const wait = async (ms: number) => { if (ms === 0) { return; } else { await new Promise(resolve => setTimeout(resolve, ms)); } };
const api = axios.create({ baseURL: env.SERVER_URL });
let redis: Redis;
let db: knex.Knex 

async function deleteAllRows() {
    try {
        await db.schema.createTableIfNotExists("debug", (t) => {
            t.bigIncrements('id').primary();
            t.text('key');
            t.binary('data');
        })

        await db('k_yrs_go_yupdates_store').truncate();
        await db('debug').truncate();
        console.log('k_yrs_go tables truncated successfully.');
    } catch (error) {
        console.error('Error deleting rows:', error);
    }
}

const debugPromises: Promise<void>[] = [];
async function debug(key: string, data: Uint8Array | Buffer) {
    debugPromises.push((async () => { db('debug').insert({key, data}); })());
}

before(async () => {
    redis = new Redis(env.REDIS_URL);

    // Clear all keys
    await redis.flushall();
    console.log('Redis cleared successfully.');

    db = knex({
        client: 'pg',
        connection: env.PG_URL,
    });

   await deleteAllRows();
   console.log('all tables truncated')
});

after(async () => {
    // Close the Redis connection
    redis.disconnect();

    await Promise.all(debugPromises)
    // Close PG connection
    await db.destroy();
});

new Array(env.RW_ITERS).fill(0).forEach((_, i) => {
    describe(`write and read iter: ${i}`, () => {
        const docId = uuid();
        const ydoc = new Y.Doc();
    
        before(() => {
            ydoc.on('update', async (update: Uint8Array, origin: any, doc: Y.Doc) => {
                try {
                    await Promise.all([
                        (async () => {
                            const res = await api.post<Uint8Array>(`/docs/${docId}/updates`, update, {headers: {'Content-Type': 'application/octet-stream'}})
                            log("update sent, response: ", res.data)
                        })(),
                        (async () => {
                            log('debug table written');
                        })()
                    ])
                } catch (err) {
                    if (axios.isAxiosError(err)) {
                        log("error sending update", err.response?.data)
                    } else {
                        log("error sending update", err)
                    }
                }
            })
        })
    
        it(`persists simple list`, async () => {
            const yarray = ydoc.getArray<string>('simple_list');
            yarray.insert(0, ['a', 'b', 'c']);
    
            await wait(env.RW_Y_OPS_WAIT_MS);
    
            yarray.insert(yarray.length, ['d', 'e', 'f'])
            
            await wait(env.RW_Y_OPS_WAIT_MS);
    
            const response = await api.get<ArrayBuffer>(`/docs/${docId}/updates`, { responseType: 'arraybuffer' });
            const update = new Uint8Array(response.data);
            
            const ydoc2 = new Y.Doc();
            Y.applyUpdate(ydoc2, update);
            const yarray2 = ydoc2.getArray('simple_list');
    
            for (let i = 0; i < yarray2.length; i++) {
                expect(yarray2.get(i)).to.equal(yarray.get(i));
            }
        })
    
        after(() => {
            ydoc.destroy();
        })
    })
})

new Array(env.COMPACTION_ITERS).fill(0).forEach((_, i) => {
    describe(`compaction iter ${i}`, () => {
        const docId = uuid();
        const ydoc = new Y.Doc();

        log("starting compaction test suite")

        before(() => {
            ydoc.on('update', async (update: Uint8Array, origin: any, doc: Y.Doc) => {
                try {
                    await api.post<Uint8Array>(`/docs/${docId}/updates`, update, {headers: {'Content-Type': 'application/octet-stream'}})
                } catch (err) {
                    if (axios.isAxiosError(err)) {
                        log('error sending update', err.response?.data)
                    } else {
                        log("error sending update", err)
                    }
                }
            })
        });

        it(`performs compaction in db: iter ${i}`, async () => {    
            const yintlist = ydoc.getArray<number>('int_list');
            const ystrlist = ydoc.getArray<string>('str_list');

            const p = new Promise<void>((resolve) => {
                let iter = 0;
                const t = setInterval(() => {
                    logUpdate(`compaction ydoc update iter ${iter}`)
                    ydoc.transact(() => {
                        yintlist.insert(yintlist.length, [randomInt(10 ** 6), randomInt(10 ** 6)])
                        ystrlist.insert(ystrlist.length, [randomUUID().toString(), randomUUID().toString()])  
                    })
            
                    if (iter === env.COMPACTION_YDOC_UPDATE_ITERS) {
                        clearInterval(t);
                        resolve();
                    }
                    
                    iter++;
                }, env.COMPACTION_YDOC_UPDATE_INTERVAL_MS);
            });

            await p;
        
            await wait(env.COMPACTION_Y_OPS_WAIT_MS);

            let countRes = await db('k_yrs_go_yupdates_store').where('doc_id', docId).count('id');
            let rowsInDB = Number(countRes[0].count)

            const response = await api.get<ArrayBuffer>(`/docs/${docId}/updates`, { responseType: 'arraybuffer' });
            const update = new Uint8Array(response.data);
            const ydoc2 = new Y.Doc();
            Y.applyUpdate(ydoc2, update);

            await wait(env.COMPACTION_Y_OPS_WAIT_MS);
            
            const yintlist2 = ydoc2.getArray<number>('int_list');
            const ystrlist2 = ydoc2.getArray<string>('str_list');

            type Diff = {
                index: number,
                expected: string | number,
                actual: string | number
            }

            const intlistdiffs: Diff[] = []
            for (let i=0; i < yintlist.length; i++) {
                const expected = yintlist.get(i);
                const actual = yintlist2.get(i);

                if (expected !== actual) {
                    intlistdiffs.push({index: i, expected, actual});
                }
            }

            const strlistdiffs: Diff[] = []
            for (let i=0; i < ystrlist.length; i++) {
                const expected = ystrlist.get(i);
                const actual = ystrlist2.get(i);

                if (expected !== actual) {
                    strlistdiffs.push({index: i, expected, actual});
                }
            }

            log('intlistdiffs', intlistdiffs);
            log('strlistdiffs', strlistdiffs);

            expect(intlistdiffs.length).to.equal(0);
            expect(strlistdiffs.length).to.equal(0);

            await wait(env.COMPACTION_Y_OPS_WAIT_MS);

            countRes = await db('k_yrs_go_yupdates_store').where('doc_id', docId).count('id')
            rowsInDB = Number(countRes[0].count);

            expect(rowsInDB).to.lessThanOrEqual(100);

            const response2 = await api.get<ArrayBuffer>(`/docs/${docId}/updates`, { responseType: 'arraybuffer' });
            const update2 = new Uint8Array(response2.data);

            zip(update, update2).forEach(([u1, u2]) => {
                expect(u1).to.equal(u2)
            })
        })

        after(() => {
            ydoc.destroy();
        })
    })
});

new Array(env.CONSISTENCY_ITERS).fill(0).forEach((_, i) => {
    describe(`consistency - iter ${i}`, () => {
        log("starting consistency test suite")

        it(`writes and reads work consistently`, async () => {
            const docId = uuid();
            const ydoc = new Y.Doc();
            const ymap = ydoc.getMap<number>('ymap');

            let onYDocUpdateIter = 0;
            const onYDocUpdatePromises: Promise<number>[] = [];
            ydoc.on('update', async (update: Uint8Array, origin: any, doc: Y.Doc) => {
                try {
                    ((iter: number) => {
                        onYDocUpdatePromises.push(new Promise(async (resolve) => {
                            await api.post<Uint8Array>(`/docs/${docId}/updates`, update, {headers: {'Content-Type': 'application/octet-stream'}})
                            resolve(iter)
                        }))
                    })(onYDocUpdateIter)
                } catch (err) {
                    if (axios.isAxiosError(err)) {
                        log('error sending update', err.response?.data)
                    } else {
                        log("error sending update", err)
                    }
                } finally {
                    onYDocUpdateIter++;
                }
            })

            const mismatches: {want: number | undefined, got: number | undefined}[] = [];
            const times: number[] = []
            let n = 0;
            const writeAndConfirm = async () => {
                if (n == env.CONSISTENCY_SIMPLE_ITERS) {
                    return;
                }

                const t1 = new Date().getTime();
                const logs: string[] = [`simple consistency iter: ${n}`]
                
                ymap.set('n', n++);

                const waitForOnYDocUpdate = new Promise<void>((resolve) => {
                    const t = setInterval(() => {
                        if (onYDocUpdatePromises.length > 0) {
                            clearInterval(t);
                            resolve();
                        }
                    }, 0)
                });

                await waitForOnYDocUpdate;

                await new Promise<void>((resolve) => {
                    setTimeout(async () => {
                        const p = onYDocUpdatePromises.shift();
                        logs.push(`onYDocUpdate iter: ${(await p)}`);
                        
                        const ydoc2 = new Y.Doc();
                        const res = await api.get<ArrayBuffer>(`/docs/${docId}/updates`, { responseType: 'arraybuffer' });
                        const update = new Uint8Array(res.data);
                        Y.applyUpdate(ydoc2, update);

                        const ymap2 = ydoc2.getMap<number>('ymap');

                        if (ymap2.get('n') === undefined || ymap.get('n') === undefined || (ymap2.get('n') as number) < (ymap.get('n') as number)){
                            mismatches.push({want: ymap.get('n'), got: ymap2.get('n')});
                        }

                        const t2 = new Date().getTime();
                        times.push(t2-t1);
                        logs.push(`time taken: ${t2-t1}ms`);
                        logUpdate(logs.join('\n'));
                        resolve();
                    }, env.CONSISTENCY_SIMPLE_READTIMEOUT_MS);
                })
                
                writeAndConfirm();
            }

            writeAndConfirm();

            log(`mismatches`, mismatches);
            log(`average time`, (times.reduce((sum, t) => sum + t, 0) / times.length))
            expect(mismatches.length).to.equal(0);
        })



        new Array(env.CONSISTENCY_LOAD_TEST_ITERS).forEach((_, j) => {
            it(`writes and reads work consistently in load - iter: ${i}, ${j}`, async () => {
                const docId = uuid();
                const ydoc = new Y.Doc();
    
                ydoc.on('update', async (update: Uint8Array, origin: any, doc: Y.Doc) => {
                    try {
                        await api.post<Uint8Array>(`/docs/${docId}/updates`, update, {headers: {'Content-Type': 'application/octet-stream'}})
                    } catch (err) {
                        if (axios.isAxiosError(err)) {
                            log('error sending update', err.response?.data)
                        } else {
                            log("error sending update", err)
                        }
                    }
                })
    
                const yintmap = ydoc.getMap<number>('int_map');
    
                const readPromises: Promise<void>[] = [];
                const writePromise = new Promise<void>((resolve) => {
                    let iter = 0;
                    const t = setInterval(() => {
                        // logUpdate(`consistency ydoc update iter ${iter}`)        
                        
                        yintmap.set('iter', iter)
                        if (iter > 0 && iter % env.CONSISTENCY_LOAD_READ_PER_N_WRITES === 0) {
                            ((iter) => {
                                setTimeout(() => {
                                    readPromises.push(checkPersistedYDoc(iter));
                                }, env.CONSISTENCY_LOAD_YDOC_READ_TIMEOUT_MS)
                            })(iter);
                        }
    
                        if (iter === env.CONSISTENCY_LOAD_YDOC_UPDATE_ITERS) {
                            clearInterval(t);
                            resolve();
                        }
    
                        iter++;            
                    }, env.CONSISTENCY_LOAD_YDOC_UPDATE_INTERVAL_MS);
                });
    
                const mismatches: {want: number, got: number | undefined}[] = [];
    
                const checkPersistedYDoc = async (iter: number) => {
                    logUpdate(`iter received: ${iter}`);
                    const ydoc2 = new Y.Doc();
                    const res = await api.get<ArrayBuffer>(`/docs/${docId}/updates`, { responseType: 'arraybuffer' });
                    const update = new Uint8Array(res.data);
                    debug(`consistency load test update for iter: ${iter}`, update);
                    Y.applyUpdate(ydoc2, update);
                    const yintmap2 = ydoc2.getMap<number>('int_map');
    
                    try {
                        if (yintmap2.get('iter') === undefined || (yintmap2.get('iter') as number) < iter) {
                            // we check for only < iter because fresher data can be read
                            mismatches.push({want: iter, got: yintmap2.get('iter')})
                        }
                    } finally {
                        ydoc.destroy()
                    }
                }
    
                await writePromise;
                await Promise.all(readPromises);
    
                log("mismatches: ", mismatches);
                expect(mismatches.length).equal(0)
            })
        });
    })
})