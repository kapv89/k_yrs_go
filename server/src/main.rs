use actix_web::{get, post, web, App, HttpResponse, HttpServer, Responder, };
use dotenv::dotenv;
use std::env;
use std::sync::Mutex;
use r2d2_redis::{r2d2, RedisConnectionManager};

type RedisPool = r2d2::Pool<RedisConnectionManager>;

async fn not_found() -> impl Responder {
    HttpResponse::NotFound().body("404: Not Found")
}

#[get("/healthz")]
async fn healthz() -> impl Responder {
    HttpResponse::Ok().body("OK")
}

#[derive(serde::Deserialize)]
struct DocUpdate {
    data: String,
}

#[post("/docs/{doc_id}/updates")]
async fn post_doc_update(
    path: web::Path<(String,)>,
    body: web::Json<DocUpdate>,
    redis_pool: web::Data<Mutex<RedisPool>>,
) -> impl Responder {
    let (doc_id,) = path.into_inner();
    HttpResponse::Ok().body(format!("Document {} update received\nUpdate: {}", doc_id, body.data))
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    dotenv().ok();

    let redis_host = env::var("REDIS_HOST").expect("REDIS_HOST must be set");
    let redis_port = env::var("REDIS_PORT").expect("REDIS_PORT must be set");
    let redis_url = format!("redis://{}:{}", redis_host, redis_port);

    // Set up Redis connection manager
    let redis_manager = RedisConnectionManager::new(redis_url).unwrap();
    let redis_pool = r2d2::Pool::builder().build(redis_manager).unwrap();

    println!("Starting on 127.0.0.1:3000");

    HttpServer::new(move || {
        App::new()
            .service(healthz)
            .service(post_doc_update)
            .app_data(web::Data::new(Mutex::new(redis_pool.clone())))
            .default_service(
                web::route().to(not_found) // Using the custom 404 handler
            )
    })
    .bind(("127.0.0.1", 3000))?
    .run()
    .await
}
