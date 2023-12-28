package db

import (
	"context"
	"database/sql"
	"fmt"
	"math/rand"
	"time"

	"github.com/oklog/ulid/v2"

	_ "github.com/lib/pq"

	"github.com/redis/go-redis/v9"
)

func generateULID() ulid.ULID {
	t := time.Now()
	entropy := ulid.Monotonic(rand.New(rand.NewSource(t.UnixNano())), 0)
	id, err := ulid.New(ulid.Timestamp(t), entropy)
	if err != nil {
		panic(err) // handle error appropriately
	}
	return id
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
	return nil, nil
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
	_, err := p.client.ExecContext(ctx, "INSERT INTO kyrs_go_yupdates_wal (id, doc_id, update) VALUES ($1, $2)", generateULID().String(), docID, update)
	if err != nil {
		return fmt.Errorf("failed to write update to WAL: %v", err)
	}
	return nil
}

func (p *PGDB) WriteYUpdateToStore(ctx context.Context, docID string, update []byte) error {
	_, err := p.client.ExecContext(ctx, "INSERT INTO kyrs_go_yupdates_store (id, doc_id, update) VALUES ($1, $2)", generateULID().String(), docID, update)
	if err != nil {
		return fmt.Errorf("failed to write update to store: %v", err)
	}
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

func (db *DB) GetCombinedYUpdate(ctx context.Context, docID string) ([]byte, error) {
	return nil, nil
}
