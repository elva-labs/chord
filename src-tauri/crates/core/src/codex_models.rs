//! The models Codex offers an account, read through its own app-server
//! where no session of it has said them.
//!
//! A Codex session lists its models when it is ready, and the window names
//! them from that list. A window that has run no Codex session for an
//! account, such as the settings choosing a workflow step's model, asks
//! for the list here: a `codex app-server` of its own is started under the
//! account's home in the project's folder, as a history is read, and asked
//! for `model/list`, page after page to the end. The read runs on the
//! machine the project is on.

use std::collections::HashMap;
use std::path::Path;
use std::time::Instant;

use serde::Serialize;
use serde_json::json;

use crate::codex_app_server::{listed_models, next_models_cursor, MODEL_PAGES};
use crate::codex_history::{Answer, AppServer, Ask};
use crate::integrated::ModelInfo;
use crate::limits::READ_WAIT;

/// The models Codex offers, in the order it lists them.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ModelCatalog {
    pub models: Vec<ModelInfo>,
}

/// Codex's models for the account whose home is `config_dir`, or Codex's
/// own home, read by the Codex on the PATH of `env` in `project`. An
/// error where Codex cannot be started or will not list them.
pub fn read(
    env: &HashMap<String, String>,
    config_dir: Option<&Path>,
    project: &Path,
) -> Result<ModelCatalog, String> {
    let mut server = AppServer::start(env, config_dir, project, Instant::now() + READ_WAIT)?;
    server.introduce()?;
    catalog_of(&mut server)
}

/// Every page of the list, in order. A page after the first that cannot
/// be read ends the list with the pages before it.
pub(crate) fn catalog_of(server: &mut dyn Ask) -> Result<ModelCatalog, String> {
    let mut models: Vec<ModelInfo> = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..MODEL_PAGES {
        let params = match &cursor {
            Some(cursor) => json!({ "cursor": cursor }),
            None => json!({}),
        };
        let page = match server.ask("model/list", params) {
            Answer::Result(page) => page,
            _ if cursor.is_some() => break,
            Answer::Refused(error) | Answer::Gone(error) => {
                return Err(format!("Codex would not list its models: {error}"))
            }
            Answer::TooLong => return Err("Codex's list of models was too long to read".into()),
        };
        for (model, _) in listed_models(&page) {
            if !models.iter().any(|held| held.value == model.value) {
                models.push(model);
            }
        }
        match next_models_cursor(&page, cursor.as_deref()) {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    Ok(ModelCatalog { models })
}

#[cfg(test)]
#[path = "codex_models_tests.rs"]
mod tests;
