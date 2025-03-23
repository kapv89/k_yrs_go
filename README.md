# k_yrs_go - Golang database for YJS CRDT using postgres + redis

`k_yrs_go` is a database server for [YJS](https://docs.yjs.dev/) documents. It works on top of [Postgres](http://postgresql.org/) and [Redis](https://redis.io/).
`k_yrs_go` uses binary redis queues as I/O buffers for YJS document updates, and uses the following PG table to store the updates:

```sql
CREATE TABLE IF NOT EXISTS k_yrs_go_yupdates_store (
    id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL,
    data BYTEA NOT NULL
);

CREATE INDEX IF NOT EXISTS k_yrs_go_yupdates_store_doc_id_idx ON k_yrs_go_yupdates_store (doc_id);
```

Usage:

```ts
import axios from 'axios';

const api = axios.create({ baseURL: env.SERVER_URL });

const docId = uuid();
const ydoc = new Y.Doc();

// WRITE
ydoc.on('update', async (update: Uint8Array, origin: any, doc: Y.Doc) => {
    api.post<Uint8Array>(`/docs/${docId}/updates`, update, {headers: {'Content-Type': 'application/octet-stream'}})
});

// READ
const response = await api.get<ArrayBuffer>(`/docs/${docId}/updates`, { responseType: 'arraybuffer' });
const update = new Uint8Array(response.data);
const ydoc2 = new Y.Doc();
Y.applyUpdate(ydoc2, update);

```

## 1ms +- x write latencies!

[**latencies.png**](latencies.png) & [**system_config.png**](system_config.png)

Seems to be very fast on my system.

The following test (keep track of the `env.*` variables) runs successfully with the default config for me::

```ts
new Array(env.COMPACTION_ITERS).fill(0).forEach((_, i) => {
    const defaults = {
        SERVER_URL: 'http://localhost:3000',
        PG_URL: 'postgres://dev:dev@localhost:5432/k_yrs_dev?sslmode=disable',
        REDIS_URL: 'redis://localhost:6379',
        RW_Y_OPS_WAIT_MS: 0,
        COMPACTION_ITERS: 1,
        COMPACTION_YDOC_UPDATE_INTERVAL_MS: 0,
        COMPACTION_YDOC_UPDATE_ITERS: 1100,
        COMPACTION_Y_OPS_WAIT: 0
    } as const;

    const env = createEnv({
        SERVER_URL: {type: 'string', default: defaults.SERVER_URL},
        PG_URL: {type: 'string', default: defaults.PG_URL},
        REDIS_URL: {type: 'string', default: defaults.REDIS_URL},
        RW_Y_OPS_WAIT_MS: {type: 'number', default: defaults.RW_Y_OPS_WAIT_MS},
        COMPACTION_ITERS: {type: 'number', default: defaults.COMPACTION_ITERS},
        YDOC_UPDATE_INTERVAL_MS: {type: 'number', default: defaults.COMPACTION_YDOC_UPDATE_INTERVAL_MS},
        YDOC_UPDATE_ITERS: {type: 'number', default: defaults.COMPACTION_YDOC_UPDATE_ITERS},
        Y_OPS_WAIT_MS: {type: 'number', default: defaults.COMPACTION_Y_OPS_WAIT}
    });

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
```

### Clone

```bash
git clone --recurse-submodules git@github.com:kapv89/k_yrs_go.git
```

### Setup

1. Install [docker](https://docs.docker.com/engine/install/) and [docker-compose](https://docs.docker.com/compose/install/)
1. Make sure you can run `docker` without `sudo`.
1. [Install go](https://go.dev/doc/install)
1. [Install rust](https://www.rust-lang.org/tools/install)
1. [Install node.js v20.10.0+](https://github.com/nvm-sh/nvm)
1. Install [tsx](https://www.npmjs.com/package/tsx) globally `npm i -g tsx`
1. `cd k_yrs_go`
1. `npm ci`

### Run locally

```bash
turbo run dev
```

### Run test

Make sure you are running locally:

```bash
turbo run dev
```

Then run tests:

```bash
turbo run test
```

### Build

```bash
turbo run build
```

Server binary will be available as `k_yrs_go/server/server`.

#### Run prod binary

You can see an example of running in prod in [server/server.sh](server/server.sh). Tweak it however you like.


If you want to run the prod binary with default dev infra, you can do the following:

1. Spin up dev infra:
    ```bash
    turbo run dev#dev
    ```
1. Run the prod server binary
    ```bash
    turbo run server
    ```
1. Optionally, run the test-suite
    ```bash
    turbo run test
    ```

### Configuration
See the file [server/.env](server/.env)

Relevant ones are:

```bash
SERVER_PORT=3000

PG_URL=postgres://dev:dev@localhost:5432/k_yrs_dev?sslmode=disable

REDIS_URL=redis://localhost:6379

REDIS_QUEUE_MAX_SIZE=1000
```