//! Endpoint dispatch: the fetches and mutations the screens ask for, one
//! arm each, straight over `api::Client`. Mirrors `apps/server/src/rest`.

// The endpoint table covers the whole REST surface the web client uses, so
// a few arms wait for their screens.
#![allow(dead_code)]

use super::api::{ApiResult, Client, Verb};
use serde_json::json;

/// The set of fetches the screens ask for.
#[derive(Clone, Debug)]
pub enum Fetch {
    Sessions,
    Profiles,
    Models,
    Tasks,
    Approvals,
    NeedsYou,
    ServerCheck,
    /// The three settings endpoints, composed into one payload by `run_fetch`.
    Settings,
    Projects,
    Artifacts(usize),
    Cron,
    Webhooks,
    Sensors,
    Rooms,
    Room(String),
    Skills,
    Vault,
    VaultBindings,
    McpServers,
    Audit(String),
    History(String),
    Main(String),
    TaskActivity(String),
    Usage(String),
    Nodes,
    PushConfig,
    Org,
    AuthStatus,
    /// A file's bytes as text (previewable kinds only).
    ArtifactText(String),
    /// A file's raw bytes (image previews).
    ArtifactBytes(String),
    /// A profile's memory v2 payload.
    Memory(String),
    /// One of the bot's files (persona, instructions).
    BotFile { profile: String, file: String },
    /// The open browser takeover asks.
    Takeovers,
    /// One skill's detail.
    SkillDetail { profile: String, name: String },
    /// A profile's parked skill proposals.
    SkillProposals(String),
    /// A bot's saved eval cases.
    Evals(String),
    /// The eval run history.
    EvalRuns,
    /// A team's published templates.
    Templates(String),
    /// The org's active vault/connector grants.
    Grants,
}

/// The mutations, tagged at the call site so `Event::Done` routes the answer.
#[derive(Clone, Debug)]
pub enum Mutation {
    SignIn(String),
    Decide { conversation: String, call: String, approved: bool, always: bool },
    Pause(bool),
    SetModel { ref_: Option<String>, effort: Option<String> },
    SetTasksMax(f64),
    TaskCancel(String),
    ParkedRetry(String),
    CreateSession { title: Option<String>, profile: Option<String> },
    DeleteSession(String),
    PatchProfile { id: String, patch: serde_json::Value },
    NewChat(String),
    Say { room: String, text: String, to: Option<String> },
    SetPasscode(String),
    SignOut,
    PatchCron { id: String, enabled: bool },
    TryCron(String),
    TestWebhook(String),
    CreateProfile { name: String, description: Option<String> },
    PairNode(String),
    SaveBotFile { profile: String, file: String, text: String },
    SecretSubmit { call: String, values: serde_json::Value },
    SecretCancel(String),
    AnswerQuestion { conversation: String, call: String, answer: String },
    Branch { session: String, at: String },
    SkillSet { profile: String, name: String, enabled: bool },
    SkillVerdict { profile: String, id: String, accept: bool },
    CreateTeam(String),
    PatchTeam { id: String, name: String },
    DecideWithInput { conversation: String, call: String, approved: bool, input: serde_json::Value },
    EvalRun { bot: String, case_ids: Vec<String> },
    TakeoverFinish(String),
    TakeoverCancel(String),
    TemplateCopy { id: String, team: String },
    TemplateUnpublish(String),
    RevokeGrant(String),
}

fn path_of(f: &Fetch) -> String {
    match f {
        Fetch::Sessions => "/api/sessions".into(),
        Fetch::Profiles => "/api/profiles".into(),
        Fetch::Models => "/api/models".into(),
        Fetch::Tasks => "/api/tasks".into(),
        Fetch::Approvals => "/api/approvals".into(),
        Fetch::NeedsYou => "/api/needs-you".into(),
        Fetch::ServerCheck => "/api/server/check".into(),
        Fetch::Settings => "/api/settings/pause".into(),
        Fetch::Projects => "/api/projects".into(),
        Fetch::Artifacts(limit) => format!("/api/artifacts?limit={limit}&sources=1"),
        Fetch::Cron => "/api/cron".into(),
        Fetch::Webhooks => "/api/webhooks".into(),
        Fetch::Sensors => "/api/sensors".into(),
        Fetch::Rooms => "/api/rooms".into(),
        Fetch::Room(id) => format!("/api/rooms/{id}"),
        Fetch::Skills => "/api/skills".into(),
        Fetch::Vault => "/api/vault".into(),
        Fetch::VaultBindings => "/api/vault/bindings".into(),
        Fetch::McpServers => "/api/mcp/servers".into(),
        Fetch::Audit(q) => format!("/api/audit?{q}"),
        Fetch::History(q) => format!("/api/history/search?q={q}"),
        Fetch::Main(profile) => format!("/api/profiles/{profile}/main"),
        Fetch::TaskActivity(id) => format!("/api/tasks/{id}/activity"),
        Fetch::Usage(p) => format!("/api/usage?profile={p}"),
        Fetch::Nodes => "/api/nodes".into(),
        Fetch::PushConfig => "/api/push/config".into(),
        Fetch::Org => "/api/org".into(),
        Fetch::AuthStatus => "/api/auth/status".into(),
        Fetch::ArtifactText(id) => format!("/api/artifacts/{id}"),
        Fetch::ArtifactBytes(id) => format!("/api/artifacts/{id}"),
        Fetch::Memory(profile) => format!("/api/memory/v2?profile={profile}"),
        Fetch::BotFile { profile, file } => format!("/api/profiles/{profile}/files/{file}"),
        Fetch::Takeovers => "/api/browser/takeover".into(),
        Fetch::SkillDetail { profile, name } => format!("/api/skills/{profile}/{name}"),
        Fetch::SkillProposals(profile) => format!("/api/skills/{profile}/proposals"),
        Fetch::Evals(bot) => format!("/api/evals?bot={bot}"),
        Fetch::EvalRuns => "/api/evals/runs".into(),
        Fetch::Templates(team) => format!("/api/org/templates?team={team}"),
        Fetch::Grants => "/api/org/grants".into(),
    }
}

/// Run one fetch. `Fetch::Settings` composes the three settings endpoints;
/// `ArtifactText` reads bytes as text and `ArtifactBytes` reads them raw
/// (the two non-JSON GETs); everything else parses JSON.
pub fn run_fetch(client: &Client, f: &Fetch) -> ApiResult<serde_json::Value> {
    if let Fetch::Settings = f {
        let pause = super::api::get_value(client, "/api/settings/pause")?;
        let model = super::api::get_value(client, "/api/settings/model")?;
        let tasks = super::api::get_value(client, "/api/settings/tasks")?;
        return Ok(json!({ "pause": pause, "model": model, "tasks": tasks }));
    }
    if let Fetch::ArtifactText(id) = f {
        let text = super::api::get_text(client, &path_of(f))?;
        let _ = id;
        return Ok(json!({ "text": text }));
    }
    if let Fetch::ArtifactBytes(id) = f {
        // Bytes ride their own event variant; this arm never returns JSON.
        let _ = id;
        return Ok(json!({}));
    }
    super::api::get_value(client, &path_of(f))
}

/// The raw bytes for the byte fetches (run after `run_fetch`'s guard pass).
pub fn run_fetch_bytes(client: &Client, f: &Fetch) -> Option<ApiResult<Vec<u8>>> {
    if let Fetch::ArtifactBytes(_) = f {
        return Some(super::api::get_bytes(client, &path_of(f)));
    }
    None
}

/// A short tag for `Event::Done` routing.
pub fn tag_of(m: &Mutation) -> String {
    match m {
        Mutation::SignIn(_) => "sign-in".into(),
        Mutation::Decide { call, .. } => format!("decide:{call}"),
        Mutation::Pause(_) => "pause".into(),
        Mutation::SetModel { .. } => "set-model".into(),
        Mutation::SetTasksMax(_) => "set-tasks-max".into(),
        Mutation::TaskCancel(id) => format!("cancel:{id}"),
        Mutation::ParkedRetry(id) => format!("retry:{id}"),
        Mutation::CreateSession { .. } => "create-session".into(),
        Mutation::DeleteSession(id) => format!("delete-session:{id}"),
        Mutation::PatchProfile { id, .. } => format!("patch-profile:{id}"),
        Mutation::NewChat(p) => format!("new-chat:{p}"),
        Mutation::Say { room, .. } => format!("say:{room}"),
        Mutation::SetPasscode(_) => "set-passcode".into(),
        Mutation::SignOut => "sign-out".into(),
        Mutation::PatchCron { id, .. } => format!("cron:{id}"),
        Mutation::TryCron(id) => format!("cron-try:{id}"),
        Mutation::TestWebhook(id) => format!("hook-test:{id}"),
        Mutation::CreateProfile { name, .. } => format!("create-profile:{name}"),
        Mutation::PairNode(name) => format!("pair-node:{name}"),
        Mutation::SaveBotFile { profile, file, .. } => format!("bot-file:{profile}:{file}"),
        Mutation::SecretSubmit { call, .. } => format!("secret:{call}"),
        Mutation::SecretCancel(call) => format!("secret:{call}"),
        Mutation::AnswerQuestion { call, .. } => format!("decide:{call}"),
        Mutation::Branch { session, .. } => format!("branch:{session}"),
        Mutation::SkillSet { profile, name, .. } => format!("skill:{profile}:{name}"),
        Mutation::SkillVerdict { profile, .. } => format!("skill-proposals:{profile}"),
        Mutation::CreateTeam(name) => format!("create-team:{name}"),
        Mutation::PatchTeam { id, .. } => format!("patch-team:{id}"),
        Mutation::DecideWithInput { call, .. } => format!("decide:{call}"),
        Mutation::EvalRun { bot, .. } => format!("eval-run:{bot}"),
        Mutation::TakeoverFinish(id) => format!("takeover:{id}"),
        Mutation::TakeoverCancel(id) => format!("takeover:{id}"),
        Mutation::TemplateCopy { team, .. } => format!("template:{team}"),
        Mutation::TemplateUnpublish(id) => format!("template:{id}"),
        Mutation::RevokeGrant(id) => format!("grant:{id}"),
    }
}

/// Run one mutation and return its answer payload.
pub fn run_mutation(client: &Client, m: &Mutation) -> ApiResult<serde_json::Value> {
    match m {
        Mutation::SignIn(passcode) => {
            let cookie = super::api::sign_in(client, passcode)?;
            Ok(json!({ "cookie": cookie }))
        }
        Mutation::Decide { conversation, call, approved, always } => {
            let path = format!("/api/approvals/{conversation}/{call}");
            super::api::send_value(client, Verb::Post, &path, json!({ "approved": approved, "always": always }))
        }
        Mutation::Pause(paused) => {
            super::api::send_value(client, Verb::Put, "/api/settings/pause", json!({ "paused": paused }))
        }
        Mutation::SetModel { ref_, effort } => {
            super::api::send_value(client, Verb::Put, "/api/settings/model", json!({ "ref": ref_, "effort": effort }))
        }
        Mutation::SetTasksMax(n) => {
            super::api::send_value(client, Verb::Put, "/api/settings/tasks", json!({ "maxRunningTasks": n }))
        }
        Mutation::TaskCancel(id) => super::api::send_value(client, Verb::Post, &format!("/api/tasks/{id}/cancel"), json!({})),
        Mutation::ParkedRetry(id) => {
            super::api::send_value(client, Verb::Post, &format!("/api/needs-you/parked/{id}/retry"), json!({}))
        }
        Mutation::CreateSession { title, profile } => super::api::send_value(
            client,
            Verb::Post,
            "/api/sessions",
            json!({ "title": title, "profileId": profile }),
        ),
        Mutation::DeleteSession(id) => super::api::send_value(client, Verb::Delete, &format!("/api/sessions/{id}"), json!({})),
        Mutation::PatchProfile { id, patch } => {
            super::api::send_value(client, Verb::Patch, &format!("/api/profiles/{id}"), patch.clone())
        }
        Mutation::NewChat(profile) => {
            super::api::send_value(client, Verb::Post, &format!("/api/profiles/{profile}/sessions"), json!({}))
        }
        Mutation::Say { room, text, to } => super::api::send_value(
            client,
            Verb::Post,
            &format!("/api/rooms/{room}/say"),
            json!({ "text": text, "to": to }),
        ),
        Mutation::SetPasscode(passcode) => {
            super::api::send_value(client, Verb::Post, "/api/auth/passcode", json!({ "passcode": passcode }))
        }
        Mutation::SignOut => super::api::send_value(client, Verb::Post, "/api/auth/sign-out", json!({})),
        Mutation::PatchCron { id, enabled } => {
            super::api::send_value(client, Verb::Patch, &format!("/api/cron/{id}"), json!({ "enabled": enabled }))
        }
        Mutation::TryCron(id) => super::api::send_value(client, Verb::Post, &format!("/api/cron/{id}/try"), json!({})),
        Mutation::TestWebhook(id) => {
            super::api::send_value(client, Verb::Post, &format!("/api/webhooks/{id}/test"), json!({ "payload": { "test": true } }))
        }
        Mutation::CreateProfile { name, description } => super::api::send_value(
            client,
            Verb::Post,
            "/api/profiles",
            json!({ "name": name, "description": description }),
        ),
        Mutation::PairNode(name) => {
            super::api::send_value(client, Verb::Post, "/api/nodes", json!({ "name": name, "roots": [] }))
        }
        Mutation::SaveBotFile { profile, file, text } => super::api::send_value(
            client,
            Verb::Put,
            &format!("/api/profiles/{profile}/files/{file}"),
            json!({ "text": text, "reason": "edited on the desktop" }),
        ),
        Mutation::SecretSubmit { call, values } => {
            super::api::send_value(client, Verb::Post, &format!("/api/secrets/{call}"), json!({ "values": values }))
        }
        Mutation::SecretCancel(call) => {
            super::api::send_value(client, Verb::Post, &format!("/api/secrets/{call}"), json!({ "cancel": true }))
        }
        Mutation::AnswerQuestion { conversation, call, answer } => super::api::send_value(
            client,
            Verb::Post,
            &format!("/api/approvals/{conversation}/{call}"),
            json!({ "approved": true, "input": { "answer": answer } }),
        ),
        Mutation::Branch { session, at } => super::api::send_value(
            client,
            Verb::Post,
            &format!("/api/sessions/{session}/branch"),
            json!({ "at": at, "mode": "from" }),
        ),
        Mutation::SkillSet { profile, name, enabled } => super::api::send_value(
            client,
            Verb::Put,
            &format!("/api/skills/{profile}/{name}"),
            json!({ "enabled": enabled }),
        ),
        Mutation::SkillVerdict { profile, id, accept } => super::api::send_value(
            client,
            Verb::Post,
            &format!("/api/skills/{profile}/proposals/{id}/{}", if *accept { "accept" } else { "reject" }),
            json!({}),
        ),
        Mutation::CreateTeam(name) => super::api::send_value(client, Verb::Post, "/api/org/teams", json!({ "name": name })),
        Mutation::PatchTeam { id, name } => {
            super::api::send_value(client, Verb::Patch, &format!("/api/org/teams/{id}"), json!({ "name": name }))
        }
        Mutation::DecideWithInput { conversation, call, approved, input } => super::api::send_value(
            client,
            Verb::Post,
            &format!("/api/approvals/{conversation}/{call}"),
            json!({ "approved": approved, "input": input }),
        ),
        Mutation::EvalRun { bot, case_ids } => super::api::send_value(
            client,
            Verb::Post,
            "/api/evals/run",
            json!({ "botId": bot, "caseIds": case_ids }),
        ),
        Mutation::TakeoverFinish(id) => {
            super::api::send_value(client, Verb::Post, &format!("/api/browser/takeover/{id}/finish"), json!({}))
        }
        Mutation::TakeoverCancel(id) => super::api::send_value(client, Verb::Delete, &format!("/api/browser/takeover/{id}"), json!({})),
        Mutation::TemplateCopy { id, team } => super::api::send_value(
            client,
            Verb::Post,
            &format!("/api/org/templates/{id}/copy"),
            json!({ "teamId": team }),
        ),
        Mutation::TemplateUnpublish(id) => {
            super::api::send_value(client, Verb::Delete, &format!("/api/org/templates/{id}"), json!({}))
        }
        Mutation::RevokeGrant(id) => super::api::send_value(client, Verb::Delete, &format!("/api/org/grants/{id}"), json!({})),
    }
}
