//! Payload types for the REST surface, mirroring `packages/contracts` shapes
//! (camelCase, optional fields as the contracts opt them). The long tail of
//! admin payloads stays `serde_json::Value` and extracts at its view.

use serde::Deserialize;

fn null<T>() -> Option<T> {
    None
}

#[derive(Clone, Debug, Deserialize)]

#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub profile: String,
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub created_at: f64,
    pub last_message_at: f64,
    #[serde(default)]
    pub participants: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize)]

#[serde(rename_all = "camelCase")]
pub struct ProfileModel {
    pub id: String,
    pub effort: String,
}

#[derive(Clone, Debug, Deserialize)]

#[serde(rename_all = "camelCase")]
pub struct ProfilePolicies {
    #[serde(default)]
    pub approval_mode: String,
    #[serde(default)]
    pub auto_approve: Vec<String>,
    #[serde(default)]
    pub approval_timeout: String,
    #[serde(default)]
    pub daily_turn_budget: Option<f64>,
    #[serde(default, deserialize_with = "bool_or_missing")]
    pub sandbox: Option<bool>,
}

fn bool_or_missing<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<bool>, D::Error> {
    Ok(Option::<bool>::deserialize(d)?)
}

#[derive(Clone, Debug, Deserialize)]

#[serde(rename_all = "camelCase")]
pub struct ProfileInfo {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub persona: String,
    pub model: Option<ProfileModel>,
    pub created_at: f64,
    pub archived_at: Option<f64>,
    #[serde(default)]
    pub team_id: Option<String>,
    #[serde(default)]
    pub host_access: Option<bool>,
    #[serde(default)]
    pub policies: Option<ProfilePolicies>,
}

#[derive(Clone, Debug, Deserialize)]

#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub label: String,
    pub provider: String,
    pub provider_name: String,
    #[serde(default)]
    pub efforts: Vec<String>,
    #[serde(default)]
    pub default_effort: String,
    #[serde(default)]
    pub input: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]

#[serde(rename_all = "camelCase")]
pub struct TaskInfo {
    pub id: String,
    pub session_id: String,
    pub prompt: String,
    pub status: String,
    pub result: Option<String>,
    pub error: Option<String>,
    pub created_at: f64,
    pub started_at: Option<f64>,
    pub finished_at: Option<f64>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub bot: Option<TaskBot>,
    #[serde(default)]
    pub updates: Option<Vec<TaskUpdate>>,
    #[serde(default)]
    pub last_step: Option<String>,
    #[serde(default)]
    pub waiting_approval: bool,
    #[serde(default)]
    pub task_conversation_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]

#[serde(rename_all = "camelCase")]
pub struct TaskBot {
    pub profile_id: String,
}

#[derive(Clone, Debug, Deserialize)]

#[serde(rename_all = "camelCase")]
pub struct TaskUpdate {
    pub at: f64,
    pub text: String,
}

#[derive(Clone, Debug, Deserialize)]

#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub conversation_id: String,
    pub profile: String,
    pub kind: String,
    #[serde(default)]
    pub session_id: Option<String>,
    pub call_id: String,
    pub name: String,
    #[serde(default)]
    pub input: Option<serde_json::Value>,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]

#[serde(rename_all = "camelCase")]
pub struct NeedsYou {
    #[serde(default)]
    pub tidy: Option<serde_json::Value>,
    #[serde(default)]
    pub parked: Option<Vec<serde_json::Value>>,
    #[serde(default)]
    pub escalations: Option<Vec<serde_json::Value>>,
    #[serde(default)]
    pub chats: Option<std::collections::HashMap<String, String>>,
}

#[derive(Clone, Debug, Deserialize)]

#[serde(rename_all = "camelCase")]
pub struct ArtifactInfo {
    pub id: String,
    pub name: String,
    pub mime: String,
    pub bytes: f64,
    pub created_at: f64,
    pub conversation_id: Option<String>,
    pub profile: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub updated_at: Option<f64>,
    #[serde(default)]
    pub source: Option<ArtifactSource>,
}

#[derive(Clone, Debug, Deserialize)]

#[serde(rename_all = "camelCase")]
pub struct ArtifactSource {
    pub session_id: String,
    pub title: String,
    pub main: bool,
    pub bot_id: String,
    #[serde(default)]
    pub task: Option<ArtifactTaskRef>,
}

#[derive(Clone, Debug, Deserialize)]

#[serde(rename_all = "camelCase")]
pub struct ArtifactTaskRef {
    pub id: String,
    pub title: String,
}

#[derive(Clone, Debug, Deserialize)]

#[serde(rename_all = "camelCase")]
pub struct ServerCheck {
    #[serde(default)]
    pub node: Option<String>,
    #[serde(default)]
    pub listen: Option<serde_json::Value>,
    #[serde(default)]
    pub meaning: Option<bool>,
    #[serde(default)]
    pub microvm: Option<bool>,
    #[serde(default)]
    pub models: Option<serde_json::Value>,
    #[serde(default)]
    pub keys: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Deserialize)]

#[serde(rename_all = "camelCase")]
pub struct WorkspaceSettings {
    #[serde(default)]
    pub paused: Option<bool>,
    #[serde(default, rename = "ref")]
    pub model_ref: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub max_running_tasks: Option<f64>,
}

impl WorkspaceSettings {
    pub fn empty() -> Self {
        WorkspaceSettings { paused: None, model_ref: None, effort: None, max_running_tasks: None }
    }
}

/// Fallback for the long-tail rows (cron rows, webhooks, sensors, rooms,
/// skills, vault items, connectors, projects, audit, evals, teams): the views
/// pull named fields off the value and treat the rest as opaque.
pub type Row = serde_json::Value;

pub fn row_str(row: &Row, key: &str) -> String {
    row.get(key).and_then(serde_json::Value::as_str).unwrap_or("").to_string()
}

pub fn row_num(row: &Row, key: &str) -> Option<f64> {
    row.get(key).and_then(serde_json::Value::as_f64)
}

pub fn row_bool(row: &Row, key: &str) -> Option<bool> {
    row.get(key).and_then(serde_json::Value::as_bool)
}

pub fn missing<T>() -> Option<T> {
    null()
}
