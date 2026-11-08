//! The /push socket: plain WebSocket, cookie-gated at handshake, coarse
//! `{"kind","at"}` frames that never carry data. Reconnects with backoff,
//! watches the 70 s silence watchdog, and maps close 4401 to Expired.

use super::{Event, Shared};
use std::sync::atomic::Ordering;
use std::time::Duration;
use tungstenite::Message;

/// The server's heartbeat lands every 25 s; silence past this reconnects.
const SILENT_AFTER: Duration = Duration::from_secs(70);
const READ_TICK: Duration = Duration::from_secs(5);

/// The push thread's whole life: connect, read, reconnect, forever.
pub fn run(shared: std::sync::Arc<Shared>) {
    let mut backoff = 1u64;
    loop {
        let auth = shared.auth.lock().unwrap().clone();
        if auth.server.is_empty() || auth.cookie.is_none() {
            std::thread::sleep(Duration::from_millis(500));
            continue;
        }
        shared.generation.store(false, Ordering::Relaxed);
        shared.inbox.lock().unwrap().push_back(Event::PushStatus("connecting"));
        match connect(&auth) {
            Ok(mut ws) => {
                backoff = 1;
                shared.inbox.lock().unwrap().push_back(Event::PushStatus("connected"));
                let ended = read_loop(shared.clone(), &mut ws);
                let _ = ws.close(None);
                if ended.is_session_ended() {
                    shared.inbox.lock().unwrap().push_back(Event::Expired);
                    return;
                }
            }
            Err(e) => {
                shared.inbox.lock().unwrap().push_back(Event::PushStatus("connecting"));
                let _ = e;
            }
        }
        // A generation bump means new auth: reconnect at once, else back off.
        let waited = wait_backoff(&shared, backoff);
        if !waited {
            backoff = 1;
        } else {
            backoff = (backoff * 2).min(10);
        }
    }
}

enum End {
    Closed,
    SessionEnded,
    Reconnect,
}

impl End {
    fn is_session_ended(&self) -> bool {
        matches!(self, End::SessionEnded)
    }
}

fn wait_backoff(shared: &std::sync::Arc<Shared>, secs: u64) -> bool {
    for _ in 0..secs * 2 {
        std::thread::sleep(Duration::from_millis(500));
        if shared.generation.load(Ordering::Relaxed) {
            return false;
        }
    }
    true
}

type Ws = tungstenite::WebSocket<tungstenite::stream::MaybeTlsStream<std::net::TcpStream>>;

fn connect(auth: &super::api::Auth) -> Result<Ws, String> {
    let url = push_url(&auth.server);
    let request = tungstenite::handshake::client::Request::builder()
        .uri(&url)
        .header("Cookie", auth.cookie.clone().unwrap_or_default())
        .body(())
        .map_err(|e| e.to_string())?;
    tungstenite::connect(request).map(|(ws, _)| ws).map_err(|e| e.to_string())
}

/// Point the underlying socket at the tick timeout so the watchdog can breathe.
fn set_read_tick(ws: &Ws) {
    let tick = Some(READ_TICK);
    match ws.get_ref() {
        tungstenite::stream::MaybeTlsStream::Plain(s) => {
            let _ = s.set_read_timeout(tick);
        }
        tungstenite::stream::MaybeTlsStream::Rustls(t) => {
            let _ = t.sock.set_read_timeout(tick);
        }
        _ => {}
    }
}

fn push_url(server: &str) -> String {
    if let Some(rest) = server.strip_prefix("https://") {
        format!("wss://{rest}/push")
    } else if let Some(rest) = server.strip_prefix("http://") {
        format!("ws://{rest}/push")
    } else {
        format!("{server}/push")
    }
}

/// Read until the socket closes, the watchdog fires, or new auth arrives.
fn read_loop(shared: std::sync::Arc<Shared>, ws: &mut Ws) -> End {
    let mut last_frame = std::time::Instant::now();
    loop {
        if shared.generation.load(Ordering::Relaxed) {
            return End::Reconnect;
        }
        match read_timeout(ws) {
            Ok(Some(msg)) => match msg {
                Message::Text(t) => {
                    last_frame = std::time::Instant::now();
                    if let Some(kind) = kind_of(&t) {
                        if kind != "heartbeat" {
                            shared.inbox.lock().unwrap().push_back(Event::Signal(kind));
                        }
                    }
                }
                Message::Close(frame) => {
                    let code = frame.map(|f| u16::from(f.code));
                    return if code == Some(4401) { End::SessionEnded } else { End::Closed };
                }
                Message::Ping(p) => {
                    let _ = ws.send(Message::Pong(p));
                }
                _ => {}
            },
            Ok(None) => {
                if last_frame.elapsed() > SILENT_AFTER {
                    return End::Closed;
                }
            }
            Err(_) => return End::Closed,
        }
    }
}

/// One bounded read: `Ok(None)` on the tick (timeout), `Err` on a dead socket.
fn read_timeout(ws: &mut Ws) -> Result<Option<Message>, ()> {
    set_read_tick(ws);
    match ws.read() {
        Ok(m) => Ok(Some(m)),
        Err(tungstenite::Error::Io(ref e))
            if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut =>
        {
            Ok(None)
        }
        Err(_) => Err(()),
    }
}

fn kind_of(text: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|v| v.get("kind").and_then(serde_json::Value::as_str).map(String::from))
}
