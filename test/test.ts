import { describe, it, before } from "node:test";
import { v4 as uuid } from "uuid";
import * as Y from 'yjs';
import axios from 'axios';
import { assert } from "node:console";

const wait = async (ms: number) => await new Promise(resolve => setTimeout(resolve, ms));
const api = axios.create({ baseURL: 'http://localhost:3000' });

describe("write and read", () => {
    const docId = uuid();
    const ydoc = new Y.Doc();

    before(() => {
        ydoc.on('update', async (update: Uint8Array, origin: any, doc: Y.Doc) => {
            try {
                await api.post<Uint8Array>(`/docs/${docId}/updates`, update, {headers: {'Content-Type': 'application/octet-stream'}})
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
            assert(yarray2.get(i) === yarray.get(i));
        }
    })
})