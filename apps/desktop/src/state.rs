//! The app state: routes, the caches every screen reads, the composer and
//! dock, and the theme preference. One `poll` drains the net inbox into here.

use crate::net::types::*;
use crate::net::{Job, Net};
use std::collections::HashMap;

/// The four nav sections plus their screens, mirroring `lib/nav.ts`.
#[derive(Clone, Debug, PartialEq)]
pub enum Route {
    /// `/`: the current bot's main chat (or the onboarding when no bots).
    Home,
    /// `/c/:id`.
    Chat(String),
    Now,
    Crew,
    Profile(String, ProfileTab),
    Team(String),
    Settings,
    Routines,
    History,
    Rooms,
    Tools(ToolsTab),
}

impl Default for Route {
    fn default() -> Self {
        Route::Home
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProfileTab {
    Overview,
    Instructions,
    Memory,
    Projects,
    Tables,
    Browser,
    Routines,
    Access,
    Files,
    Activity,
    Tests,
}

impl ProfileTab {
    pub fn id(self) -> &'static str {
        match self {
            ProfileTab::Overview => "overview",
            ProfileTab::Instructions => "instructions",
            ProfileTab::Memory => "memory",
            ProfileTab::Projects => "projects",
            ProfileTab::Tables => "tables",
            ProfileTab::Browser => "browser",
            ProfileTab::Routines => "routines",
            ProfileTab::Access => "access",
            ProfileTab::Files => "files",
            ProfileTab::Activity => "activity",
            ProfileTab::Tests => "tests",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            ProfileTab::Overview => "Overview",
            ProfileTab::Instructions => "Instructions",
            ProfileTab::Memory => "Memory",
            ProfileTab::Projects => "Work",
            ProfileTab::Tables => "Tables",
            ProfileTab::Browser => "Browser",
            ProfileTab::Routines => "Routines",
            ProfileTab::Access => "Access",
            ProfileTab::Files => "Files",
            ProfileTab::Activity => "Activity",
            ProfileTab::Tests => "Tests",
        }
    }

    pub fn from_id(id: &str) -> ProfileTab {
        match id {
            "instructions" => ProfileTab::Instructions,
            "memory" => ProfileTab::Memory,
            "projects" => ProfileTab::Projects,
            "tables" => ProfileTab::Tables,
            "browser" => ProfileTab::Browser,
            "routines" => ProfileTab::Routines,
            "access" => ProfileTab::Access,
            "files" => ProfileTab::Files,
            "activity" => ProfileTab::Activity,
            "tests" => ProfileTab::Tests,
            _ => ProfileTab::Overview,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolsTab {
    Connectors,
    Skills,
    Vault,
}

impl ToolsTab {
    pub fn label(self) -> &'static str {
        match self {
            ToolsTab::Connectors => "Connectors",
            ToolsTab::Skills => "Skills",
            ToolsTab::Vault => "Vault",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThemeMode {
    System,
    Light,
    Dark,
}

impl ThemeMode {
    pub fn next(self) -> ThemeMode {
        match self {
            ThemeMode::System => ThemeMode::Light,
            ThemeMode::Light => ThemeMode::Dark,
            ThemeMode::Dark => ThemeMode::System,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            ThemeMode::System => "System",
            ThemeMode::Light => "Light",
            ThemeMode::Dark => "Dark",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Gate {
    /// Asking the server who we are.
    Checking,
    /// The sign-in form (or setup): passcode field + words.
    SignIn { passcode: rune::TextEdit, error: Option<String>, first: bool },
    /// Signed in; everything renders.
    Ready,
}

/// One work-dock tab (`lib/work-stack.ts` kinds).
#[derive(Clone, Debug, PartialEq)]
pub enum DockTab {
    Task(String),
    File(String),
    Memory { profile: String, name: String, query: Option<String> },
    Needs,
    Room(String),
}

pub struct App {
    pub net: Net,
    /// The job receiver, moved to the worker in `setup`.
    pub rx: Option<std::sync::mpsc::Receiver<Job>>,
    pub server: String,
    pub cookie: Option<String>,
    pub gate: Gate,
    pub route: Route,

    // Caches (the web's app-state slices, same shape).
    pub sessions: Vec<SessionInfo>,
    pub profiles: Vec<ProfileInfo>,
    pub models: Vec<ModelInfo>,
    pub workspace_default: Option<ProfileModel>,
    pub tasks: Vec<TaskInfo>,
    pub approvals: Vec<Approval>,
    pub needs: Option<NeedsYou>,
    pub check: Option<ServerCheck>,
    pub settings: WorkspaceSettings,
    pub artifacts: Vec<ArtifactInfo>,
    pub projects: Vec<Row>,
    pub cron: Vec<Row>,
    pub webhooks: Vec<Row>,
    pub sensors: Vec<Row>,
    pub rooms: Vec<Row>,
    pub room: Option<Row>,
    pub skills: Vec<Row>,
    pub vault: Vec<Row>,
    pub bindings: Vec<Row>,
    pub mcp: Vec<Row>,
    pub audit: Vec<Row>,
    pub history: Vec<Row>,
    pub org: Option<Row>,
    /// The last search the History filter ran (rows of the Messages section).
    pub message_search: Option<Vec<Row>>,

    /// Which fetch's first answer has landed (the screen renders a skeleton
    /// until its key is here), and each fetch's last error words.
    pub loaded: std::collections::HashSet<String>,
    pub errors: HashMap<String, String>,

    /// The push socket's word: connected / connecting / disconnected.
    pub push: &'static str,
    pub theme: ThemeMode,
    /// The composer's draft, kept per open chat (cleared on send).
    pub draft: String,
    /// The quick switcher's state while open.
    pub switcher: Option<Switcher>,
    /// The work dock's tabs (max five, oldest not looked at gives way).
    pub dock: Vec<DockTab>,
    pub dock_active: usize,
    /// The last bot a chat was opened with (`lastBot` in `lib/app-state.tsx`).
    pub last_bot: Option<String>,
    /// A transient toast line (saved words, errors), cleared after a beat.
    pub toast: Option<String>,
    pub toast_at: Option<f64>,
    /// `GET /api/auth/status`: whether a passcode exists, and the cookie works.
    pub passcode_set: Option<bool>,
    /// A scratch TextEdit the gate text field binds to when unmounted.
    pub scratch_edit: rune::TextEdit,
    pub has_session: Option<bool>,
    /// The route the screens last mounted, so a change refetches their data.
    pub mounted_route: Option<Route>,
    /// The chord bridge (the Node sidecar) and the chat it holds.
    pub bridge: crate::bridge::Bridge,
    pub chat: Vec<ChatMessage>,
    pub chat_live: bool,
    pub chat_loaded: bool,
    pub chat_phase: String,
    pub chat_session: Option<String>,
    pub chat_draft: rune::TextEdit,
    pub room_draft: rune::TextEdit,
    pub history_query: rune::TextEdit,
    /// Text previews the dock has loaded, by artifact id.
    pub previews: HashMap<String, String>,
    /// The quick switcher's query field.
    pub switcher_edit: rune::TextEdit,
}

/// One message the transcript holds, projected from a chord transcript entry.
#[derive(Clone, Debug, PartialEq)]
pub struct ChatMessage {
    pub role: String,
    pub text: String,
    pub streaming: bool,
}

impl ChatMessage {
    /// From a contracts TranscriptEntry: input/output are the two voices,
    /// notes render quiet; tool rows arrive later through the lens.
    pub fn of(entry: &serde_json::Value) -> Option<ChatMessage> {
        let kind = entry.get("kind")?.as_str()?;
        let (role, words, streaming) = match kind {
            "input" => ("user", entry.get("text")?.as_str()?, false),
            "output" => (
                "assistant",
                entry.get("text")?.as_str()?,
                entry.get("streaming").and_then(serde_json::Value::as_bool).unwrap_or(false),
            ),
            "note" => ("note", entry.get("text")?.as_str()?, false),
            "thinking" => ("thinking", entry.get("text")?.as_str()?, false),
            _ => return None,
        };
        Some(ChatMessage { role: role.into(), text: words.into(), streaming })
    }
}

impl Default for App {
    fn default() -> Self {
        let (net, rx) = Net::new();
        App {
            net,
            rx: Some(rx),
            server: String::new(),
            cookie: None,
            gate: Gate::Checking,
            route: Route::Home,
            sessions: Vec::new(),
            profiles: Vec::new(),
            models: Vec::new(),
            workspace_default: None,
            tasks: Vec::new(),
            approvals: Vec::new(),
            needs: None,
            check: None,
            settings: WorkspaceSettings::empty(),
            artifacts: Vec::new(),
            projects: Vec::new(),
            cron: Vec::new(),
            webhooks: Vec::new(),
            sensors: Vec::new(),
            rooms: Vec::new(),
            room: None,
            skills: Vec::new(),
            vault: Vec::new(),
            bindings: Vec::new(),
            mcp: Vec::new(),
            audit: Vec::new(),
            history: Vec::new(),
            org: None,
            message_search: None,
            loaded: std::collections::HashSet::new(),
            errors: HashMap::new(),
            push: "connecting",
            theme: ThemeMode::System,
            draft: String::new(),
            switcher: None,
            dock: Vec::new(),
            dock_active: 0,
            last_bot: None,
            toast: None,
            toast_at: None,
            passcode_set: None,
            scratch_edit: rune::TextEdit::new(String::new()),
            has_session: None,
            mounted_route: None,
            bridge: crate::bridge::Bridge::default(),
            chat: Vec::new(),
            chat_live: false,
            chat_loaded: false,
            chat_phase: "idle".into(),
            chat_session: None,
            chat_draft: rune::TextEdit::new(String::new()),
            room_draft: rune::TextEdit::new(String::new()),
            history_query: rune::TextEdit::new(String::new()),
            previews: HashMap::new(),
            switcher_edit: rune::TextEdit::new(String::new()),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Switcher {
    pub active: usize,
}

impl App {
    /// The bot whose chat the home screen shows: `lastBot`, else the main bot.
    pub fn current_bot(&self) -> Option<&ProfileInfo> {
        let id = self.current_bot_id()?;
        self.profiles.iter().find(|p| p.id == id)
    }

    pub fn current_bot_id(&self) -> Option<String> {
        if let Some(b) = &self.last_bot {
            if self.profiles.iter().any(|p| &p.id == b) {
                return Some(b.clone());
            }
        }
        self.main_bot().map(|p| p.id.clone())
    }

    /// The main bot: the first created (the install's main) is the lowest id.
    pub fn main_bot(&self) -> Option<&ProfileInfo> {
        self.profiles.iter().min_by(|a, b| a.id.cmp(&b.id))
    }

    pub fn visible_bots(&self) -> Vec<&ProfileInfo> {
        let mut bots: Vec<&ProfileInfo> = self.profiles.iter().filter(|p| p.archived_at.is_none()).collect();
        bots.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        bots
    }

    /// The bot a session belongs to, by id.
    pub fn bot_of_session(&self, session_id: &str) -> Option<&ProfileInfo> {
        let profile = self.sessions.iter().find(|s| s.id == session_id)?.profile.clone();
        self.profiles.iter().find(|p| p.id == profile)
    }

    pub fn bot_name(&self, profile_id: &str) -> String {
        self.profiles
            .iter()
            .find(|p| p.id == profile_id)
            .map(|p| p.name.clone())
            .unwrap_or_else(|| "a bot".to_string())
    }

    /// Running and queued task count (the busy set the chrome derives).
    pub fn busy_count(&self) -> usize {
        self.tasks.iter().filter(|t| t.status == "running" || t.status == "queued").count()
    }

    /// Needs-you rows: approvals, failed tasks, parked, escalations, tidy.
    pub fn needs_count(&self) -> usize {
        let tidy = self.needs.as_ref().map(|n| tidy_count(n)).unwrap_or(0);
        let parked = self.needs.as_ref().and_then(|n| n.parked.as_ref()).map(Vec::len).unwrap_or(0);
        let escalations = self
            .needs
            .as_ref()
            .and_then(|n| n.escalations.as_ref())
            .map(Vec::len)
            .unwrap_or(0);
        let failed = self.tasks.iter().filter(|t| t.status == "failed").count();
        self.approvals.len() + parked + escalations + tidy + failed
    }

    pub fn mark_loaded(&mut self, tag: &str) {
        self.loaded.insert(tag.to_string());
        self.errors.remove(tag);
    }

    pub fn note_error(&mut self, tag: &str, message: String) {
        self.errors.insert(tag.to_string(), message);
    }

    pub fn has(&self, tag: &str) -> bool {
        self.loaded.contains(tag)
    }
}

fn tidy_count(n: &NeedsYou) -> usize {
    n.tidy.as_ref().map(|t| t.get("count").and_then(serde_json::Value::as_f64).unwrap_or(0.0) as usize).unwrap_or(0)
}
