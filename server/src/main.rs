use actix_web::{get, App, HttpResponse, HttpServer, Responder};

#[get("/healthz")]
async fn healthz() -> impl Responder {
    HttpResponse::Ok().body("OK")
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    println!("Starting on 127.0.0.1:3000");

    let res = HttpServer::new(|| {
        App::new()
            .service(healthz)
    })
    .bind(("127.0.0.1", 3000))?
    .run()
    .await;

    return res;
}
