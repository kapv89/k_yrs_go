package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"server/db"

	"github.com/gin-gonic/gin"
	"golang.org/x/sync/errgroup"
)

const DEFAULT_SERVE_PORT = 3000
const DEFAULT_MODE = "prod"

var (
	serverHost        string
	serverPort        int
	redisURL          string
	pgURL             string
	mode              string
	user              string
	password          string
	debug             bool
	redisQueueMaxSize int
)

var (
	dbh *db.DB
)

var (
	dataConsistencyErrChan chan error
)

func init() {
	flag.StringVar(&serverHost, "SERVER_HOST", "localhost", "Server host")
	flag.IntVar(&serverPort, "SERVER_PORT", 3000, "Server port")
	flag.StringVar(&redisURL, "REDIS_URL", "redis://localhost:6379", "Redis URL")
	flag.StringVar(&pgURL, "PG_URL", "", "PostgreSQL URL")
	flag.StringVar(&mode, "MODE", DEFAULT_MODE, "Mode")
	flag.StringVar(&user, "USER", "", "User")
	flag.StringVar(&password, "PASSWORD", "", "Password")
	flag.BoolVar(&debug, "DEBUG", false, "Debug")
	flag.IntVar(&redisQueueMaxSize, "REDIS_QUEUE_MAX_SIZE", 100, "Redis Queue Max Size")
	flag.Parse()
}

func init() {
	var err error
	dbh, err = db.NewDB(db.DBConfig{
		RedisURL:          redisURL,
		PGURL:             pgURL,
		Debug:             debug,
		RedisQueueMaxSize: redisQueueMaxSize,
	})
	if err != nil {
		panic(err)
	}
}

func init() {
	dataConsistencyErrChan = make(chan error, 1)
}

func setupRouter() *gin.Engine {
	// Disable Console Color
	// gin.DisableConsoleColor()
	r := gin.Default()

	r.SetTrustedProxies(nil)

	if user != "" && password != "" {
		r.Use(gin.BasicAuth(gin.Accounts{
			user: password,
		}))
	}

	r.GET("/healthz", func(c *gin.Context) {
		c.String(http.StatusOK, "ok")
	})

	r.GET("/docs/:id/updates", func(c *gin.Context) {
		docID := c.Params.ByName("id")
		res, err := dbh.GetCombinedYUpdate(c.Request.Context(), docID)
		if err != nil {
			c.String(http.StatusInternalServerError, "Error reading updates from redis")
			return
		}

		c.Data(http.StatusOK, "application/octet-stream", res.CombinedUpdate)

		if res.ShouldPerformCompaction {
			err = dbh.PG.PerformCompaction(c.Request.Context(), docID, res.LastId, res.CombinedUpdate, res.PGUpdatesCount)
			if err != nil {
				dataConsistencyErrChan <- fmt.Errorf("error performing compaction: %v", err)
			}
		}
	})

	r.POST("/docs/:id/updates", func(c *gin.Context) {
		contentType := c.Request.Header.Get("Content-Type")
		if contentType != "application/octet-stream" {
			c.String(http.StatusBadRequest, "Invalid content type")
			return
		}

		docID := c.Params.ByName("id")

		body, err := io.ReadAll(c.Request.Body)
		if err != nil {
			c.String(http.StatusInternalServerError, "Error reading request body")
			return
		}

		ackErrgroup, ackEgctx := errgroup.WithContext(c.Request.Context())
		ackErrgroup.SetLimit(1)

		ackErrgroup.Go(func() error {
			return dbh.Redis.PushYUpdate(ackEgctx, docID, body)
		})

		commitErrgroup, commitEgctx := errgroup.WithContext(c.Request.Context())
		commitErrgroup.SetLimit(1)

		commitErrgroup.Go(func() error {
			return dbh.PG.WriteYUpdateToStore(commitEgctx, docID, body)
		})

		err = ackErrgroup.Wait()
		if err != nil {
			c.String(http.StatusInternalServerError, "Error writing updates: %v", err)
			return
		}

		c.String(http.StatusOK, "ok")

		err = commitErrgroup.Wait()
		if err != nil {
			dataConsistencyErrChan <- fmt.Errorf("error writing doc:%s updates to store: %v", docID, err)
		}
	})

	log.Print("Router setup complete\n")

	return r
}

func main() {
	log.Printf("Starting server on port %d\n\n", serverPort)

	tablesSetupChan := make(chan struct{})
	serverErrChan := make(chan error)
	ctx := context.Background()

	go func() {
		err := dbh.PG.SetupTables(ctx)
		if err != nil {
			serverErrChan <- fmt.Errorf("error setting up tables: %v", err)
			close(serverErrChan)
		}

		tablesSetupChan <- struct{}{}
		close(tablesSetupChan)
	}()

	go func() {
		r := setupRouter()
		serverErrChan <- r.Run(fmt.Sprintf("%s:%d", serverHost, serverPort))
		close(serverErrChan)
	}()

	<-tablesSetupChan

	go func() {
		for err := range dataConsistencyErrChan {
			log.Printf("Data consistency error: %v", err)
		}
	}()

	select {
	case err := <-serverErrChan:
		log.Fatalf("Error running server: %v", err)
	case <-ctx.Done():
		log.Println("Server stopped")
	}
}
