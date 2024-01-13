import { describe, it, before, after } from "node:test";
import { v4 as uuid } from "uuid";
import * as Y from 'yjs';
import axios from 'axios';
import Redis from 'ioredis';
import knex from 'knex';
import {expect} from "chai";

const wait = async (ms: number) => await new Promise(resolve => setTimeout(resolve, ms));
const api = axios.create({ baseURL: 'http://localhost:3000' });
let redis: Redis;
let db: knex.Knex 

async function deleteAllRows() {
    try {
        await db.schema.dropTable('k_yrs_go_yupdates_wal');
        await db.schema.dropTable('k_yrs_go_yupdates_store');
        console.log('k_yrs_go tables dropped successfully.');
    } catch (error) {
        console.error('Error deleting rows:', error);
    }
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
                const res = await api.post<Uint8Array>(`/docs/${docId}/updates`, update, {headers: {'Content-Type': 'application/octet-stream'}})
                console.log('update sent, res:', res.headers)
            } catch (err) {
                if (axios.isAxiosError(err)) {
                    console.log(err.response?.data)
                } else {
                    console.log(err)
                }
            }
        })
    })

    it(`persists simple list`, async () => {
        const yarray = ydoc.getArray('simple_list');
        yarray.insert(0, ['a', 'b', 'c']);

        await wait(1000);

        const response = await api.get<ArrayBuffer>(`/docs/${docId}/updates`, { responseType: 'arraybuffer' });
        const update = new Uint8Array(response.data);
        
        const ydoc2 = new Y.Doc();
        Y.applyUpdate(ydoc2, update);
        const yarray2 = ydoc2.getArray('simple_list');

        for (let i = 0; i < yarray2.length; i++) {
            expect(yarray2.get(i)).to.equal(yarray.get(i));
        }
    })
})