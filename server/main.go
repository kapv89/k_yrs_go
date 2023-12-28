package main

/*
#cgo LDFLAGS: -L. -lyrs
#include <libyrs.h>
*/
import "C"

import (
	"flag"
	"fmt"
	"io"
	"net/http"
	"server/db"
	"sync"

	"github.com/gin-gonic/gin"
)

const DEFAULT_SERVE_PORT = 3000
const DEFAULT_MODE = "prod"

var (
	serverPort int
	redisURL   string
	pgURL      string
	mode       string
)

var (
	dbh *db.DB
)

func init() {
	flag.IntVar(&serverPort, "SERVER_PORT", 3000, "Server port")
	flag.StringVar(&redisURL, "REDIS_URL", "", "Redis URL")
	flag.StringVar(&pgURL, "PG_URL", "", "PostgreSQL URL")
	flag.StringVar(&mode, "MODE", DEFAULT_MODE, "Mode")
	flag.Parse()
}

func init() {
	var err error
	dbh, err = db.NewDB(db.DBConfig{
		RedisURL: redisURL,
		PGURL:    pgURL,
	})
	if err != nil {
		panic(err)
	}
}

func setupRouter() *gin.Engine {
	// Disable Console Color
	// gin.DisableConsoleColor()
	r := gin.Default()

	r.GET("/healthz", func(c *gin.Context) {
		c.String(http.StatusOK, "ok")
	})

	r.GET("/docs/:id/updates", func(c *gin.Context) {
		docID := c.Params.ByName("id")
		update, err := dbh.GetCombinedYUpdate(c.Request.Context(), docID)
		if err != nil {
			c.String(http.StatusInternalServerError, "Error reading updates from redis")
			return
		}

		c.Data(http.StatusOK, "application/octet-stream", update)
	})

	r.POST("/docs/:id/updates", func(c *gin.Context) {
		contentType := c.Request.Header.Get("Content-Type")
		if contentType != "application/octet-stream" {
			c.String(http.StatusBadRequest, "Invalid content type")
			return
		}

		docID := c.Params.ByName("id")

		// Read binary data from request body
		body, err := io.ReadAll(c.Request.Body)
		if err != nil {
			// Handle error
			c.String(http.StatusInternalServerError, "Error reading request body")
			return
		}

		// Log the binary data
		wgAck := sync.WaitGroup{}
		wgAck.Add(2)

		go func() {
			defer wgAck.Done()
			dbh.PG.WriteYUpdateToWAL(c.Request.Context(), docID, body)
		}()
		go func() {
			defer wgAck.Done()
			dbh.Redis.PushYUpdate(c.Request.Context(), docID, body)
		}()

		wgCommit := sync.WaitGroup{}
		wgCommit.Add(1)
		go func() {
			defer wgCommit.Done()
			dbh.PG.WriteYUpdateToStore(c.Request.Context(), docID, body)
		}()

		wgAck.Wait()

		c.String(http.StatusOK, "ok")

		wgCommit.Wait()
	})

	return r
}

func main() {
	ydoc := C.ydoc_new()

	fmt.Printf("ydoc: %v\n", ydoc)
	fmt.Println("Hello, world!")

	r := setupRouter()
	// Listen and Server in 0.0.0.0:3000
	r.Run(":3000")
}
