use serde::Serialize;
use std::fs;
use std::path::PathBuf;
use tauri::Manager;

#[derive(Serialize)]
pub struct RawNote {
    file: String,
    content: String,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            notes_dir,
            load_all,
            save_note,
            delete_note,
            open_notes_dir
        ])
        .run(tauri::generate_context!())
        .expect("启动简记失败");
}

/// 笔记存放目录：优先 ~/Documents/简记，退回到应用数据目录
fn dir_of(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .document_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|e| format!("无法定位存储目录: {e}"))?;
    let dir = base.join("简记");
    fs::create_dir_all(&dir).map_err(|e| format!("创建目录失败: {e}"))?;
    Ok(dir)
}

/// 只允许同目录下的 .md 文件，阻断路径穿越
fn file_path(app: &tauri::AppHandle, file: &str) -> Result<PathBuf, String> {
    if file.is_empty() || file.contains('/') || file.contains('\\') || file.contains("..") {
        return Err("非法的文件名".into());
    }
    if !file.to_lowercase().ends_with(".md") {
        return Err("只接受 .md 文件".into());
    }
    Ok(dir_of(app)?.join(file))
}

#[tauri::command]
fn notes_dir(app: tauri::AppHandle) -> Result<String, String> {
    Ok(dir_of(&app)?.to_string_lossy().to_string())
}

#[tauri::command]
fn load_all(app: tauri::AppHandle) -> Result<Vec<RawNote>, String> {
    let dir = dir_of(&app)?;
    let entries = fs::read_dir(&dir).map_err(|e| format!("读取目录失败: {e}"))?;
    let mut out = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let name = match path.file_name().and_then(|s| s.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if let Ok(content) = fs::read_to_string(&path) {
            out.push(RawNote {
                file: name,
                content,
            });
        }
    }

    out.sort_by(|a, b| a.file.cmp(&b.file));
    Ok(out)
}

#[tauri::command]
fn save_note(app: tauri::AppHandle, file: String, content: String) -> Result<(), String> {
    let path = file_path(&app, &file)?;
    // 先写临时文件再改名，避免写入中途崩溃导致笔记损坏
    let tmp = path.with_extension("md.tmp");
    fs::write(&tmp, content).map_err(|e| format!("写入失败: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("保存失败: {e}"))?;
    Ok(())
}

#[tauri::command]
fn delete_note(app: tauri::AppHandle, file: String) -> Result<(), String> {
    let path = file_path(&app, &file)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("删除失败: {e}"))?;
    }
    Ok(())
}

/// 让用户在访达 / 资源管理器里打开笔记文件夹
#[tauri::command]
fn open_notes_dir(app: tauri::AppHandle) -> Result<(), String> {
    let dir = dir_of(&app)?;
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
