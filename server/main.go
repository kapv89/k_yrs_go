package main

/*
#cgo LDFLAGS: -L. -lyrs
#include <libyrs.h>
*/
import "C"

import (
	"flag"
	"fmt"
	"net/http"

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

func init() {
	flag.IntVar(&serverPort, "SERVER_PORT", 3000, "Server port")
	flag.StringVar(&redisURL, "REDIS_URL", "", "Redis URL")
	flag.StringVar(&pgURL, "PG_URL", "", "PostgreSQL URL")
	flag.StringVar(&mode, "MODE", DEFAULT_MODE, "Mode")
	flag.Parse()
}

var db = make(map[string]string)

func setupRouter() *gin.Engine {
	// Disable Console Color
	// gin.DisableConsoleColor()
	r := gin.Default()

	r.GET("/healthz", func(c *gin.Context) {
		c.String(http.StatusOK, "ok")
	})

	r.POST("/docs/:id/updates", func(c *gin.Context) {
		docID := c.Params.ByName("id")
		c.String(http.StatusOK, "docID: %s", docID)
		fmt.Println("--->docID: ", docID)
	})

	// Ping test
	r.GET("/ping", func(c *gin.Context) {
		c.String(http.StatusOK, "pong")
	})

	// Get user value
	r.GET("/user/:name", func(c *gin.Context) {
		user := c.Params.ByName("name")
		value, ok := db[user]
		if ok {
			c.JSON(http.StatusOK, gin.H{"user": user, "value": value})
		} else {
			c.JSON(http.StatusOK, gin.H{"user": user, "status": "no value"})
		}
	})

	// Authorized group (uses gin.BasicAuth() middleware)
	// Same than:
	// authorized := r.Group("/")
	// authorized.Use(gin.BasicAuth(gin.Credentials{
	//	  "foo":  "bar",
	//	  "manu": "123",
	//}))
	authorized := r.Group("/", gin.BasicAuth(gin.Accounts{
		"foo":  "bar", // user:foo password:bar
		"manu": "123", // user:manu password:123
	}))

	/* example curl for /admin with basicauth header
	   Zm9vOmJhcg== is base64("foo:bar")

		curl -X POST \
	  	http://localhost:8080/admin \
	  	-H 'authorization: Basic Zm9vOmJhcg==' \
	  	-H 'content-type: application/json' \
	  	-d '{"value":"bar"}'
	*/
	authorized.POST("admin", func(c *gin.Context) {
		user := c.MustGet(gin.AuthUserKey).(string)

		// Parse JSON
		var json struct {
			Value string `json:"value" binding:"required"`
		}

		if c.Bind(&json) == nil {
			db[user] = json.Value
			c.JSON(http.StatusOK, gin.H{"status": "ok"})
		}
	})

	return r
}

func main() {
	ydoc := C.ydoc_new()

	fmt.Printf("ydoc: %v\n", ydoc)
	fmt.Println("Hello, world!")

	r := setupRouter()
	// Listen and Server in 0.0.0.0:8080
	r.Run(":3000")
}
