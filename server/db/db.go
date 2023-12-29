package db

/*
#cgo LDFLAGS: -L. -lyrs
#include <libyrs.h>
#include <string.h>
*/
import "C"

import (
	"context"
	"database/sql"
	"fmt"
	"math/rand"
	"sync"
	"time"
	"unsafe"

	"github.com/oklog/ulid/v2"

	_ "github.com/lib/pq"

	"github.com/redis/go-redis/v9"
)

func generateULID() (ulid.ULID, error) {
	t := time.Now()
	entropy := ulid.Monotonic(rand.New(rand.NewSource(t.UnixNano())), 0)
	id, err := ulid.New(ulid.Timestamp(t), entropy)
	if err != nil {
		return ulid.ULID{}, err // handle error appropriately
	}
	return id, nil
}

func byteSliceToCString(b []byte) *C.char {
	if len(b) == 0 {
		return (*C.char)(C.calloc(1, 1)) // Allocate 1 byte and set it to 0 (null terminator)
	}
	cstr := (*C.char)(C.malloc(C.size_t(len(b) + 1)))  // Allocate memory for the string + null terminator
	copy((*[1 << 30]byte)(unsafe.Pointer(cstr))[:], b) // Copy the slice data
	(*[1 << 30]byte)(unsafe.Pointer(cstr))[len(b)] = 0 // Set the null terminator
	return cstr
}

func cStringToByteSlice(cstr *C.char) []byte {
	if cstr == nil {
		return nil
	}
	length := C.strlen(cstr)
	slice := make([]byte, length)
	copy(slice, (*[1 << 30]byte)(unsafe.Pointer(cstr))[:length:length])
	return slice
}

func combineYUpdates(updates [][]byte) []byte {
	ydoc := C.ydoc_new()

	for _, update := range updates {
		cUpdateStr := byteSliceToCString(update)
		cBytesLen := C.uint(len(update))

		wtrx := C.ydoc_write_transaction(ydoc, cBytesLen, cUpdateStr)
		C.ytransaction_apply(wtrx, cUpdateStr, cBytesLen)
		C.ytransaction_commit(wtrx)

		C.free(unsafe.Pointer(cUpdateStr))
	}

	rtrx := C.ydoc_read_transaction(ydoc)
	cBytesLen := C.uint(0)
	cCombinedUpdate := C.ytransaction_state_vector_v1(rtrx, &cBytesLen)
	combinedUpdate := cStringToByteSlice(cCombinedUpdate)
	C.free(unsafe.Pointer(cCombinedUpdate))

	return combinedUpdate
}

type RedisDB struct {
	client         *redis.Client
	queueKeyPrefix string
	queueMaxSize   int
}

const DEFAULT_REDIS_QUEUE_KEY = "k_yrs_go.yupdates"
const DEFAULT_REDIS_QUEUE_MAX_SIZE = 100

func NewRedisDB(url string) (*RedisDB, error) {
	opts, err := redis.ParseURL(url)
	if err != nil {
		return nil, fmt.Errorf("failed to parse redis url: %v", err)
	}

	client := redis.NewClient(opts)
	return &RedisDB{
		client:         client,
		queueKeyPrefix: DEFAULT_REDIS_QUEUE_KEY,
		queueMaxSize:   DEFAULT_REDIS_QUEUE_MAX_SIZE,
	}, nil
}

func (r *RedisDB) Close() error {
	return r.client.Close()
}

func (r *RedisDB) queueKey(docID string) string {
	return fmt.Sprintf("%s.%s", r.queueKeyPrefix, docID)
}

const REDIS_QUEUE_PUSH_LUA_SCRIPT = `
local queue_key = KEYS[1]
local data = ARGV[1]
local queue_size = tonumber(redis.call('LLEN', queue_key))

if queue_size >= tonumber(ARGV[2]) then
    redis.call('LPOP', queue_key)
end

redis.call('RPUSH', queue_key, data)
`

func (r *RedisDB) PushYUpdate(ctx context.Context, docID string, update []byte) error {
	_, err := r.client.Eval(ctx, REDIS_QUEUE_PUSH_LUA_SCRIPT, []string{r.queueKey(docID)}, update, r.queueMaxSize).Result()
	if err != nil {
		return fmt.Errorf("failed to push update to Redis queue: %v", err)
	}
	return nil
}

func (r *RedisDB) GetCombinedYUpdate(ctx context.Context, docID string) ([]byte, error) {
	strUpdates, err := r.client.LRange(ctx, r.queueKey(docID), 0, -1).Result()
	if err != nil {
		return nil, fmt.Errorf("failed to get yupdates from Redis queue: %v", err)
	}

	byteUpdates := make([][]byte, len(strUpdates))
	for i, s := range strUpdates {
		byteUpdates[i] = []byte(s)
	}

	combinedUpdate := combineYUpdates(byteUpdates)

	return combinedUpdate, nil
}

type PGDB struct {
	client *sql.DB
}

func NewPGDB(url string) (*PGDB, error) {
	db, err := sql.Open("postgres", url)
	if err != nil {
		return nil, fmt.Errorf("failed to open postgres db: %v", err)
	}

	return &PGDB{
		client: db,
	}, nil
}

func (p *PGDB) Close() error {
	return p.client.Close()
}

func (p *PGDB) WriteYUpdateToWAL(ctx context.Context, docID string, update []byte) error {
	id, err := generateULID()
	if err != nil {
		return fmt.Errorf("failed to generate ULID in WriteYUpdateToWAL: %v", err)
	}

	_, err = p.client.ExecContext(ctx, "INSERT INTO kyrs_go_yupdates_wal (id, doc_id, data) VALUES ($1, $2)", id.String(), docID, update)
	if err != nil {
		return fmt.Errorf("failed to write update to WAL: %v", err)
	}
	return nil
}

func (p *PGDB) WriteYUpdateToStore(ctx context.Context, docID string, update []byte) error {
	id, err := generateULID()
	if err != nil {
		return fmt.Errorf("failed to generate ULID in WriteYUpdateToStore: %v", err)
	}

	_, err = p.client.ExecContext(ctx, "INSERT INTO kyrs_go_yupdates_store (id, doc_id, data) VALUES ($1, $2)", id.String(), docID, update)
	if err != nil {
		return fmt.Errorf("failed to write update to store: %v", err)
	}
	return nil
}

type PGCombinedYUpdateRes struct {
	CombinedUpdate []byte
	LastId         string
	UpdatesCount   int
}

func (p *PGDB) GetCombinedYUpdate(ctx context.Context, docID string) (PGCombinedYUpdateRes, error) {
	rows, err := p.client.QueryContext(ctx, "SELECT id, data FROM kyrs_go_yupdates_store WHERE doc_id = $1 order by id asc", docID)
	if err != nil {
		return PGCombinedYUpdateRes{
			CombinedUpdate: nil,
			LastId:         ulid.ULID{}.String(),
			UpdatesCount:   0,
		}, fmt.Errorf("failed to query updates from store: %v", err)
	}
	defer rows.Close()

	var updates [][]byte
	var lastId string
	for rows.Next() {
		var update []byte
		var id string
		err := rows.Scan(&id, &update)
		if err != nil {
			return PGCombinedYUpdateRes{
				CombinedUpdate: nil,
				LastId:         ulid.ULID{}.String(),
				UpdatesCount:   0,
			}, fmt.Errorf("failed to scan update: %v", err)
		}
		lastId = id
		updates = append(updates, update)
	}

	combinedUpdate := combineYUpdates(updates)

	return PGCombinedYUpdateRes{
		CombinedUpdate: combinedUpdate,
		LastId:         lastId,
		UpdatesCount:   len(updates),
	}, nil
}

func (p *PGDB) PerformCompaction(ctx context.Context, docID string, lastID string, combinedUpdate []byte) error {
	deleteUpdates := func() error {
		// Delete rows from store table
		_, err := p.client.ExecContext(ctx, "DELETE FROM kyrs_go_yupdates_store WHERE doc_id = $1 AND id <= $2", docID, lastID)
		if err != nil {
			return fmt.Errorf("failed to delete rows from store table: %v", err)
		}

		return nil
	}

	insertCombinedUpdate := func() error {
		// Insert combined update with new ULID
		newID, err := generateULID()
		if err != nil {
			return fmt.Errorf("failed to generate ULID in PerformCompaction: %v", err)
		}

		_, err = p.client.ExecContext(ctx, "INSERT INTO kyrs_go_yupdates_store (doc_id, id, data) VALUES ($1, $2, $3)", docID, newID, combinedUpdate)
		if err != nil {
			return fmt.Errorf("failed to insert combined update into store table: %v", err)
		}

		return nil
	}

	wg := sync.WaitGroup{}
	wg.Add(2)

	// TODO: handle errors

	go func() {
		defer wg.Done()
		deleteUpdates()
	}()
	go func() {
		defer wg.Done()
		insertCombinedUpdate()
	}()

	return nil
}

type DB struct {
	Redis *RedisDB
	PG    *PGDB
}

type DBConfig struct {
	RedisURL string
	PGURL    string
}

func NewDB(redisURL DBConfig) (*DB, error) {
	redisDB, err := NewRedisDB(redisURL.RedisURL)
	if err != nil {
		return nil, fmt.Errorf("failed to create redis db: %v", err)
	}

	pgDB, err := NewPGDB(redisURL.PGURL)
	if err != nil {
		return nil, fmt.Errorf("failed to create pg db: %v", err)
	}

	return &DB{
		Redis: redisDB,
		PG:    pgDB,
	}, nil
}

func (db *DB) Close() error {
	if err := db.Redis.Close(); err != nil {
		return fmt.Errorf("failed to close redis db: %v", err)
	}

	return nil
}

type DBCombinedYUpdateRes struct {
	CombinedUpdate          []byte
	ShouldPerformCompaction bool
	LastId                  string
}

func (db *DB) GetCombinedYUpdate(ctx context.Context, docID string) (DBCombinedYUpdateRes, error) {
	redisCh := make(chan []byte)
	pgCh := make(chan *PGCombinedYUpdateRes)

	go func() {
		defer close(redisCh)
		combinedUpdate, err := db.Redis.GetCombinedYUpdate(ctx, docID)
		if err != nil {
			redisCh <- nil
			return
		}
		redisCh <- combinedUpdate
	}()

	go func() {
		defer close(pgCh)
		cuRes, err := db.PG.GetCombinedYUpdate(ctx, docID)
		if err != nil {
			pgCh <- nil
			return
		}

		pgCh <- &cuRes
	}()

	redisCombinedUpdate := <-redisCh
	pgCombinedUpdateRes := <-pgCh

	if redisCombinedUpdate == nil && pgCombinedUpdateRes == nil {
		return DBCombinedYUpdateRes{
			CombinedUpdate:          []byte{},
			ShouldPerformCompaction: false,
		}, nil
	} else if pgCombinedUpdateRes == nil {
		return DBCombinedYUpdateRes{
			CombinedUpdate:          redisCombinedUpdate,
			ShouldPerformCompaction: false,
		}, nil
	} else if redisCombinedUpdate == nil {
		return DBCombinedYUpdateRes{
			CombinedUpdate:          pgCombinedUpdateRes.CombinedUpdate,
			ShouldPerformCompaction: pgCombinedUpdateRes.UpdatesCount > 100,
			LastId:                  pgCombinedUpdateRes.LastId,
		}, nil
	} else {
		combinedUpdate := combineYUpdates([][]byte{redisCombinedUpdate, pgCombinedUpdateRes.CombinedUpdate})
		return DBCombinedYUpdateRes{
			CombinedUpdate:          combinedUpdate,
			ShouldPerformCompaction: pgCombinedUpdateRes.UpdatesCount > 100,
			LastId:                  pgCombinedUpdateRes.LastId,
		}, nil
	}
}
