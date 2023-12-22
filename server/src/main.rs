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

#[post("/docs/{doc_id}/updates")]
async fn post_doc_update(
    path: web::Path<(String,)>,
    mut body: Multipart,
    redis_pool: web::Data<Mutex<RedisPool>>,
    config: web::Data<Config>,
) -> impl Responder {
    let (doc_id,) = path.into_inner();
    let redis_queue_key = format!("{}{}", config.redis_queue_prefix, doc_id);

    while let Ok(Some(mut field)) = body.try_next().await {
        let content_type = field.content_disposition();
        let field_name = content_type.get_name().unwrap();

        if field_name == "data" {
            let mut bytes = BytesMut::new();
            while let Some(chunk) = field.next().await {
                let data = chunk.unwrap();
                bytes.extend_from_slice(&data);
            }

            let _ = redis_queue_push(redis_pool, redis_queue_key, bytes.freeze(), config).await;

            return HttpResponse::Ok().body(format!("Document {} update received", doc_id));
        }
    }

    HttpResponse::BadRequest().body("Field 'data' not found")
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

async fn redis_queue_push(
    redis_pool: web::Data<Mutex<RedisPool>>,
    redis_queue_key: String,
    data: Bytes,
    config: web::Data<Config>,
) -> Result<(), String> {
    let pool = redis_pool.lock().unwrap();
    let mut redis_conn = pool.get().await.unwrap();
    let data_vec = data.to_vec();

    let _: () = redis::Script::new(REDIS_QUEUE_PUSH_LUA_SCRIPT)
        .key(&redis_queue_key)
        .arg(&data_vec)
        .arg(config.redis_max_queue_size)
        .invoke_async(&mut *redis_conn)
        .await
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

    let redis_host = env::var("REDIS_HOST").expect("REDIS_HOST must be set");
    let redis_port = env::var("REDIS_PORT").expect("REDIS_PORT must be set");
    let redis_url = format!("redis://{}:{}", redis_host, redis_port);

    // Set up Redis connection manager
    let redis_manager = RedisConnectionManager::new(redis_url).unwrap();
    let redis_pool = bb8::Pool::builder().build(redis_manager).await.unwrap();

    let pg_user = env::var("PG_USER").expect("PG_USER must be set");
    let pg_pass = env::var("PG_PASS").expect("PG_PASS must be set");
    let pg_db = env::var("PG_DB").expect("PG_DB must be set");
    let pg_host = env::var("PG_HOST").expect("PG_HOST must be set");
    let pg_port = env::var("PG_PORT").expect("PG_PORT must be set");

    let pg_url = format!(
        "postgres://{}:{}@{}:{}/{}",
        pg_user, pg_pass, pg_host, pg_port, pg_db
    );

    // Set up PostgreSQL connection manager
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
