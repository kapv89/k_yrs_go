import { describe, it, before, after } from "node:test";
import { v4 as uuid } from "uuid";
import * as Y from 'yjs';
import axios from 'axios';
import Redis from 'ioredis';
import knex from 'knex';
import {expect} from "chai";
import { randomInt, randomUUID } from "crypto";
import { createEnv } from 'neon-env';

const log = (key: string, value?: any) => typeof value !== "undefined" ? console.log(`======> ${key}`, value) : console.log(`======> ${key}:`);

const defaults = {
    RW_Y_OPS_WAIT_MS: 0,
    COMPACTION_ITERS: 1,
    COMPACTION_YDOC_UPDATE_INTERVAL_MS: 5,
    COMPACTION_YDOC_UPDATE_ITERS: 1000,
    COMPACTION_Y_OPS_WAIT: 0
} as const;


const env = createEnv({
    RW_Y_OPS_WAIT_MS: {type: 'number', default: defaults.RW_Y_OPS_WAIT_MS},
    COMPACTION_ITERS: {type: 'number', default: defaults.COMPACTION_ITERS},
    YDOC_UPDATE_INTERVAL_MS: {type: 'number', default: defaults.COMPACTION_YDOC_UPDATE_INTERVAL_MS},
    YDOC_UPDATE_ITERS: {type: 'number', default: defaults.COMPACTION_YDOC_UPDATE_ITERS},
    Y_OPS_WAIT_MS: {type: 'number', default: defaults.COMPACTION_Y_OPS_WAIT}
});

const wait = async (ms: number) => { if (ms === 0) { return; } else { await new Promise(resolve => setTimeout(resolve, ms)); } };
const api = axios.create({ baseURL: 'http://localhost:3000' });
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

async function debug(key: string, data: Uint8Array | Buffer) {
    await db('debug').insert({key, data});
}

before(async () => {
    redis = new Redis({
        host: 'localhost',
        port: 6379,
    });

    // Clear all keys
    await redis.flushall();
    console.log('Redis cleared successfully.');

    db = knex({
        client: 'pg',
        connection: 'postgres://dev:dev@localhost:5432/k_yrs_dev?sslmode=disable',
    });

   await deleteAllRows();
});

after(async () => {
    // Close the Redis connection
    redis.disconnect();

    // Close PG connection
    await db.destroy();
});

describe("write and read", () => {
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
                    log("ydoc update iter", iter)
                    iter++;
        
                    ydoc.transact(() => {
                        yintlist.insert(yintlist.length, [randomInt(10 ** 6), randomInt(10 ** 6)])
                        ystrlist.insert(ystrlist.length, [randomUUID().toString(), randomUUID().toString()])  
                    })
            
                    if (iter === env.YDOC_UPDATE_ITERS) {
                        clearInterval(t);
                        resolve();
                    }
                }, env.YDOC_UPDATE_INTERVAL_MS);
            });

            await p;
        
            await wait(env.Y_OPS_WAIT_MS);

            let countRes = await db('k_yrs_go_yupdates_store').where('doc_id', docId).count('id');
            let rowsInDB = Number(countRes[0].count)

            const response = await api.get<ArrayBuffer>(`/docs/${docId}/updates`, { responseType: 'arraybuffer' });
            const update = new Uint8Array(response.data);

            const ydoc2 = new Y.Doc();
            Y.applyUpdate(ydoc2, update);

            await wait(env.Y_OPS_WAIT_MS);
            
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

            await wait(env.Y_OPS_WAIT_MS);

            countRes = await db('k_yrs_go_yupdates_store').where('doc_id', docId).count('id')
            rowsInDB = Number(countRes[0].count);

            expect(rowsInDB).to.lessThanOrEqual(100);
        })

        after(() => {
            ydoc.destroy();
        })
    })
});