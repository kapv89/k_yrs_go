package db

import (
	"fmt"

	"github.com/redis/go-redis/v9"
)

type RedisDB struct {
	client *redis.Client
}

func NewRedisDB(url string) (*RedisDB, error) {
	opts, err := redis.ParseURL(url)
	if err != nil {
		return nil, fmt.Errorf("failed to parse redis url: %v", err)
	}

	client := redis.NewClient(opts)
	return &RedisDB{client: client}, nil
}

func (r *RedisDB) Close() error {
	return r.client.Close()
}
