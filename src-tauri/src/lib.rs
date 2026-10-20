use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

#[derive(Serialize)]
pub struct RawNote {
    /// 相对笔记根目录的路径，用 / 分隔。
    /// 根目录下的笔记是 "周报.md"，笔记本里的则是 "工作/周报.md"
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
            open_notes_dir,
            list_notebooks,
            create_notebook,
            rename_notebook,
            delete_notebook
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

/// 笔记本名合法性：必须是单层目录名
fn check_notebook_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("笔记本名称不能为空".into());
    }
    if name.chars().count() > 60 {
        return Err("笔记本名称过长".into());
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("笔记本名称不能包含 / \\ 或 ..".into());
    }
    if name.starts_with('.') {
        return Err("笔记本名称不能以 . 开头".into());
    }
    Ok(())
}

/// 拆分并校验相对路径：允许「笔记本/文件名.md」或「文件名.md」两种，最多一层子目录
fn split_rel(file: &str) -> Result<Vec<String>, String> {
    if file.is_empty() {
        return Err("文件名为空".into());
    }
    let parts: Vec<&str> = file.split('/').collect();
    if parts.len() > 2 {
        return Err("最多只支持一层笔记本目录".into());
    }
    for p in &parts {
        if p.is_empty() || *p == "." || *p == ".." || p.contains('\\') {
            return Err("非法的路径".into());
        }
    }
    match parts.last() {
        Some(last) if last.to_lowercase().ends_with(".md") => {}
        _ => return Err("只接受 .md 文件".into()),
    }
    Ok(parts.into_iter().map(|s| s.to_string()).collect())
}

fn note_path(app: &tauri::AppHandle, file: &str) -> Result<PathBuf, String> {
    let parts = split_rel(file)?;
    let mut path = dir_of(app)?;
    for part in &parts {
        path.push(part);
    }
    Ok(path)
}

/// 扫描某个目录下的 .md（不递归），prefix 是相对根目录的前缀
fn read_md(dir: &Path, prefix: &str, out: &mut Vec<RawNote>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let name = match path.file_name().and_then(|s| s.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if let Ok(content) = fs::read_to_string(&path) {
            out.push(RawNote {
                file: if prefix.is_empty() {
                    name
                } else {
                    format!("{prefix}/{name}")
                },
                content,
            });
        }
    }
}

#[tauri::command]
fn notes_dir(app: tauri::AppHandle) -> Result<String, String> {
    Ok(dir_of(&app)?.to_string_lossy().to_string())
}

#[tauri::command]
fn load_all(app: tauri::AppHandle) -> Result<Vec<RawNote>, String> {
    let dir = dir_of(&app)?;
    let mut out = Vec::new();

    // 根目录（未分类）
    read_md(&dir, "", &mut out);

    // 每个笔记本目录
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let name = match path.file_name().and_then(|s| s.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            if name.starts_with('.') {
                continue;
            }
            read_md(&path, &name, &mut out);
        }
    }

    out.sort_by(|a, b| a.file.cmp(&b.file));
    Ok(out)
}

#[tauri::command]
fn save_note(app: tauri::AppHandle, file: String, content: String) -> Result<(), String> {
    let path = note_path(&app, &file)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建笔记本目录失败: {e}"))?;
    }
    // 先写临时文件再改名，避免写入中途崩溃导致笔记损坏
    let tmp = path.with_extension("md.tmp");
    fs::write(&tmp, content).map_err(|e| format!("写入失败: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("保存失败: {e}"))?;
    Ok(())
}

#[tauri::command]
fn delete_note(app: tauri::AppHandle, file: String) -> Result<(), String> {
    let path = note_path(&app, &file)?;
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

/* ---------------- 笔记本 ---------------- */

#[tauri::command]
fn list_notebooks(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let dir = dir_of(&app)?;
    let entries = fs::read_dir(&dir).map_err(|e| format!("读取目录失败: {e}"))?;
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if let Some(name) = path.file_name().and_then(|s| s.to_str()) {
            if !name.starts_with('.') {
                out.push(name.to_string());
            }
        }
    }
    out.sort();
    Ok(out)
}

#[tauri::command]
fn create_notebook(app: tauri::AppHandle, name: String) -> Result<(), String> {
    check_notebook_name(&name)?;
    let dir = dir_of(&app)?.join(&name);
    if dir.exists() {
        return Err(format!("笔记本「{name}」已存在"));
    }
    fs::create_dir_all(&dir).map_err(|e| format!("创建笔记本失败: {e}"))
}

#[tauri::command]
fn rename_notebook(app: tauri::AppHandle, from: String, to: String) -> Result<(), String> {
    check_notebook_name(&from)?;
    check_notebook_name(&to)?;
    let base = dir_of(&app)?;
    let src = base.join(&from);
    let dst = base.join(&to);
    if !src.exists() {
        return Err(format!("笔记本「{from}」不存在"));
    }
    if dst.exists() {
        return Err(format!("笔记本「{to}」已存在"));
    }
    fs::rename(&src, &dst).map_err(|e| format!("重命名失败: {e}"))
}

#[tauri::command]
fn delete_notebook(app: tauri::AppHandle, name: String) -> Result<(), String> {
    check_notebook_name(&name)?;
    let dir = dir_of(&app)?.join(&name);
    if !dir.exists() {
        return Ok(());
    }
    // 只删空目录：里面有笔记就拒绝，避免误删
    let has_note = fs::read_dir(&dir)
        .map_err(|e| format!("读取失败: {e}"))?
        .flatten()
        .any(|e| {
            e.path().extension().and_then(|s| s.to_str()) == Some("md")
        });
    if has_note {
        return Err("这个笔记本里还有笔记，先把笔记移走或删除".into());
    }
    fs::remove_dir(&dir).map_err(|e| format!("删除笔记本失败: {e}"))
}
