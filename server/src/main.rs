use actix_web::{get, post, web, App, HttpResponse, HttpServer, Responder};
use actix_multipart::Multipart;
use futures::{StreamExt, TryStreamExt};
use dotenv::dotenv;
use std::env;
use std::sync::Mutex;
use bb8_redis::{bb8, RedisConnectionManager};
use actix_web::web::{Bytes, BytesMut};
use bb8_postgres::PostgresConnectionManager;
use tokio_postgres::NoTls;
use tokio_postgres::types::ToSql;
use tokio::task;
use futures::future;

type RedisPool = bb8::Pool<RedisConnectionManager>;

#[derive(Clone)]
struct Config {
    redis_queue_prefix: String,
    redis_max_queue_size: i32,
}

async fn not_found() -> impl Responder {
    HttpResponse::NotFound().body("404: Not Found")
}

#[get("/healthz")]
async fn healthz() -> impl Responder {
    HttpResponse::Ok().body("OK")
}

const DATA_FIELD_NAME: &'static str = "data";

#[post("/docs/{doc_id}/updates")]
async fn post_doc_update(
    path: web::Path<(String,)>,
    mut body: Multipart,
    redis_pool: web::Data<Mutex<RedisPool>>,
    pg_pool: web::Data<Mutex<bb8::Pool<PostgresConnectionManager<NoTls>>>>,
    config: web::Data<Config>,
) -> impl Responder {
    let (doc_id,) = path.into_inner();

    while let Ok(Some(mut field)) = body.try_next().await {
        let content_type = field.content_disposition();
        let field_name = content_type.get_name().unwrap();

        if field_name == DATA_FIELD_NAME {
            let mut bytes_mut = BytesMut::new();
            while let Some(chunk) = field.next().await {
                let data = chunk.unwrap();
                bytes_mut.extend_from_slice(&data);
            }

            let bytes = bytes_mut.freeze();

            let redis_queue_push_task = tokio::task::spawn_blocking(move || {
                task::block_in_place(|| {
                    redis_queue_push(redis_pool.clone(), doc_id.clone(), bytes.clone(), config.clone())
                })
            });
            let write_to_wal_task = task::spawn(write_to_wal(pg_pool.clone(), doc_id.clone(), bytes.clone()));
            let write_to_doc_store_task = task::spawn(write_to_doc_store(pg_pool.clone(), doc_id.clone(), bytes.clone()));

            let (_, _, _) = tokio::try_join!(redis_queue_push_task, write_to_wal_task, write_to_doc_store_task)?;

            return HttpResponse::Ok().body(format!("Document {} update received", doc_id));
        }
    }

    HttpResponse::BadRequest().body("Field 'data' not found")
}

async fn write_to_doc_store(
    pg_pool: web::Data<Mutex<bb8::Pool<PostgresConnectionManager<NoTls>>>>,
    doc_id: String,
    data: Bytes,
) -> Result<(), String> {
    let pg_pool_mutex_guard = pg_pool.lock().unwrap();
    let pg_conn_res = pg_pool_mutex_guard.get().await;
    if pg_conn_res.is_err() {
        return Err("Failed to get PostgreSQL connection from pool".to_string());
    }
    let pg_conn = pg_conn_res.unwrap();

    let stmt = pg_conn.prepare("INSERT INTO store (doc_id, data) VALUES ($1, $2)").await.unwrap();
    let params: [&(dyn ToSql + Sync); 2] = [&doc_id, &data.to_vec()];
    pg_conn.execute(&stmt, &params).await.unwrap();

    Ok(())
}

async fn write_to_wal(
    pg_pool: web::Data<Mutex<bb8::Pool<PostgresConnectionManager<NoTls>>>>,
    doc_id: String,
    data: Bytes,
) -> Result<(), String> {
    let pg_pool_mutex_guard = pg_pool.lock().unwrap();
    let pg_conn_res = pg_pool_mutex_guard.get().await;
    if pg_conn_res.is_err() {
        return Err("Failed to get PostgreSQL connection from pool".to_string());
    }
    let pg_conn = pg_conn_res.unwrap();

    let stmt = pg_conn.prepare("INSERT INTO wal (doc_id, data) VALUES ($1, $2)").await.unwrap();
    let params: [&(dyn ToSql + Sync); 2] = [&doc_id, &data.to_vec()];
    pg_conn.execute(&stmt, &params).await.unwrap();

    Ok(())
}

const REDIS_QUEUE_PUSH_LUA_SCRIPT: &'static str = r#"
local queue_key = KEYS[1]
local data = ARGV[1]
local queue_size = tonumber(redis.call('LLEN', queue_key))

if queue_size >= tonumber(ARGV[2]) then
    redis.call('LPOP', queue_key)
end

redis.call('RPUSH', queue_key, data)
"#;

fn redis_queue_push(
    redis_pool: web::Data<Mutex<RedisPool>>,
    doc_id: String,
    data: Bytes,
    config: web::Data<Config>,
) -> Result<(), String> {
    let redis_queue_key = format!("{}{}", config.redis_queue_prefix, doc_id);

    // Acquire a blocking lock on the Redis pool
    let pool = redis_pool.lock().unwrap();
    
    // Get a Redis connection in a blocking manner
    let mut redis_conn = tokio::task::block_in_place(|| {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            pool.get().await.map_err(|err| format!("Failed to get Redis connection: {}", err))
        })
    })?;
    
    let data_vec = data.to_vec();

    // Invoke Lua script synchronously
    let _: () = redis::Script::new(REDIS_QUEUE_PUSH_LUA_SCRIPT)
        .key(&redis_queue_key)
        .arg(&data_vec)
        .arg(config.redis_max_queue_size)
        .invoke(&mut *redis_conn)
        .map_err(|err| format!("Failed to execute Lua script for `redis_queue_push`: {}", err))?;

    Ok(())
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    dotenv().ok();

    let config = Config {
        redis_queue_prefix: "mem_cache_queue:".to_string(),
        redis_max_queue_size: 100,
    };

    let server_host = env::var("SERVER_HOST").expect("SERVER_HOST must be set");
    let server_port = env::var("SERVER_PORT").expect("SERVER_PORT must be set");

    // Set up Redis connection manager
    let redis_url = env::var("REDIS_URL").expect("REDIS_URL must be set");
    let redis_manager = RedisConnectionManager::new(redis_url).unwrap();
    let redis_pool = bb8::Pool::builder().build(redis_manager).await.unwrap();

    
    // Set up PostgreSQL connection manager
    let pg_url = env::var("PG_URL").expect("PG_URL must be set");
    let pg_manager = PostgresConnectionManager::new_from_stringlike(pg_url, NoTls).unwrap();
    let pg_pool = bb8::Pool::builder().build(pg_manager).await.unwrap();

    println!("Starting on {}:{}", server_host, server_port);

    HttpServer::new(move || {
        App::new()
            .service(healthz)
            .service(post_doc_update)
            .app_data(web::Data::new(Mutex::new(redis_pool.clone())))
            .app_data(web::Data::new(config.clone()))
            .app_data(web::Data::new(pg_pool.clone())) // Add PostgreSQL connection pool
            .default_service(web::route().to(not_found)) // Using the custom 404 handler
    })
    .bind((server_host, server_port.parse::<u16>().unwrap()))?
    .run()
    .await
}
