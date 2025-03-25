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
    
    CONSISTENCY_SIMPLE_ITERS: 1,
    CONSISTENCY_SIMPLE_READTIMEOUT_MS: 0,
    CONSISTENCY_SIMPLE_YDOC_UPDATE_ITERS: 10000,

    CONSISTENCY_LOAD_TEST_ITERS: 1,
    CONSISTENCY_LOAD_YDOC_UPDATE_ITERS: 10000,
    CONSISTENCY_LOAD_YDOC_UPDATE_TIMEOUT_MS: 2,
    CONSISTENCY_LOAD_READ_PER_N_WRITES: 5,
    CONSISTENCY_LOAD_YDOC_READ_TIMEOUT_MS: 3,
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
    log('redis cleared successfully.');

    db = knex({
        client: 'pg',
        connection: env.PG_URL,
    });

   await deleteAllRows();
   log('all tables truncated')
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

            expect(rowsInDB).to.greaterThan(100);

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

new Array(env.CONSISTENCY_SIMPLE_ITERS).fill(0).forEach((_, i) => {
    describe(`consistency simple- iter ${i}`, () => {
        log("starting consistency test suite")

        it(`writes and reads work consistently iter:${i}`, async () => {
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
                if (n == env.CONSISTENCY_SIMPLE_YDOC_UPDATE_ITERS) {
                    return;
                }

                const t1 = new Date().getTime();
                
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

                // validate from db
                await new Promise<void>((resolve) => {
                    setTimeout(async () => {
                        const p = onYDocUpdatePromises.shift();
                        logUpdate(`simple consistency onYDocUpdate iter: ${(await p)}`);
                        
                        const ydoc2 = new Y.Doc();
                        const res = await api.get<ArrayBuffer>(`/docs/${docId}/updates`, { responseType: 'arraybuffer' });
                        const update = new Uint8Array(res.data);
                        Y.applyUpdate(ydoc2, update);

                        const ymap2 = ydoc2.getMap<number>('ymap');

                        if (ymap2.get('n') === undefined || ymap.get('n') === undefined || (ymap2.get('n') as number) !== (ymap.get('n') as number)){
                            mismatches.push({want: ymap.get('n'), got: ymap2.get('n')});
                        }

                        const t2 = new Date().getTime();
                        times.push(t2-t1);
                        resolve();
                        ydoc2.destroy();
                    }, env.CONSISTENCY_SIMPLE_READTIMEOUT_MS);
                })
                
                await writeAndConfirm();
            }

            await writeAndConfirm();

            log(`mismatches`, mismatches);
            log(`average time per write+read+check (ms)`, (times.reduce((sum, t) => sum + t, 0) / times.length))
            expect(mismatches.length).to.equal(0);
        })
    })
})

new Array(env.CONSISTENCY_LOAD_TEST_ITERS).fill(0).forEach((_, i) => {
    describe(`consistency load - iter: ${i}`, () => {
        it(`writes and reads work consistently in load - iter: ${i}`, async () => {
            const docId = uuid();
            const ydoc = new Y.Doc();
            const yintmap = ydoc.getMap<number>('int_map');

            const onYDocUpdatePromises: Promise<void>[] = [];
            ydoc.on('update', async (update: Uint8Array, origin: any, doc: Y.Doc) => {
                onYDocUpdatePromises.push(Promise.resolve());
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


            const mismatches: {want: number, got: number | undefined}[] = [];
            const readPromises: Promise<void>[] = [];

            let n = 0;
            const write = async () => {
                if (n == env.CONSISTENCY_LOAD_YDOC_UPDATE_ITERS) {
                    return;
                }

                yintmap.set('n', n);

                const waitForYDocUpdate = new Promise<void>((resolve) => {
                    const t = setInterval(async () => {
                        if (onYDocUpdatePromises.length > 0) {
                            const p = onYDocUpdatePromises.shift();
                            await p;
                            resolve();
                            clearInterval(t);
                        }
                    }, 0)
                })

                await waitForYDocUpdate;

                if (n > 0 && n % env.CONSISTENCY_LOAD_READ_PER_N_WRITES === 0) {
                    ((n) => {
                        setTimeout(() => {
                            readPromises.push(checkPersistedYDoc(n));
                        }, env.CONSISTENCY_LOAD_YDOC_READ_TIMEOUT_MS);
                    })(n);
                }
                
                n++;
                await wait(env.CONSISTENCY_LOAD_YDOC_UPDATE_TIMEOUT_MS)
                await write();
            }

            const checkPersistedYDoc = async (n: number) => {
                logUpdate(`consistency in load checkPersistedYDoc n received: ${n}`);
                const ydoc2 = new Y.Doc();
                const res = await api.get<ArrayBuffer>(`/docs/${docId}/updates`, { responseType: 'arraybuffer' });
                const update = new Uint8Array(res.data);
                Y.applyUpdate(ydoc2, update);
                const yintmap2 = ydoc2.getMap<number>('int_map');

                if (yintmap2.get('n') === undefined || (yintmap2.get('n') as number) < n) {
                    // we check for only < n because fresher data can be read
                    mismatches.push({want: n, got: yintmap2.get('n')})
                }
            }

            await write();
            await Promise.all(readPromises);

            log("mismatches: ", mismatches);
            expect(mismatches.length).equal(0)
        })
    })
});