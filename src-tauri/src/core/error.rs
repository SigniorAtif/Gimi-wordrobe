use serde::Serialize;

/// Error type returned to the frontend as `{ code, message }`.
#[derive(Debug, thiserror::Error, Serialize, Clone, PartialEq)]
#[error("{message}")]
pub struct AppError {
    pub code: String,
    pub message: String,
}

impl AppError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        AppError { code: code.into(), message: message.into() }
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::new("io", e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::new("json", e.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
