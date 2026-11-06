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
            delete_notebook,
            save_asset,
            read_asset,
            delete_asset,
            open_asset,
            open_url,
            read_external_file,
            read_external_image
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

/// 删除笔记本目录。
/// 非 force 时只允许删「没有 .md 的」目录；force 时连目录里的东西一起删。
/// 抽出来是为了能单测：删不掉笔记本这个 bug 就出在这段判断上。
fn remove_notebook_dir(base: &Path, name: &str, force: bool) -> Result<(), String> {
    check_notebook_name(name)?;
    let dir = base.join(name);
    if !dir.exists() {
        return Ok(());
    }
    if !force {
        let has_note = fs::read_dir(&dir)
            .map_err(|e| format!("读取失败: {e}"))?
            .flatten()
            .any(|e| e.path().extension().and_then(|s| s.to_str()) == Some("md"));
        if has_note {
            return Err("这个笔记本里还有笔记，先把笔记移走或删除".into());
        }
    }
    // 用 remove_dir_all：目录里可能还有 .DS_Store 之类的杂物，
    // remove_dir 会因为「目录非空」失败，表现成点了删除没反应
    fs::remove_dir_all(&dir).map_err(|e| format!("删除笔记本失败: {e}"))
}

#[tauri::command]
fn delete_notebook(app: tauri::AppHandle, name: String, force: Option<bool>) -> Result<(), String> {
    let base = dir_of(&app)?;
    remove_notebook_dir(&base, &name, force.unwrap_or(false))
}

/// 用系统默认程序打开一个路径（访达 / 浏览器 / 默认应用）
fn open_with_system(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", ""])
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/* ---------------- 网页附件（笔记里嵌入的 .html） ---------------- */

/// 附件目录：笔记根目录下的 .assets（隐藏目录，不会被当成笔记本扫进来）
fn asset_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = dir_of(app)?.join(".assets");
    fs::create_dir_all(&dir).map_err(|e| format!("创建附件目录失败: {e}"))?;
    Ok(dir)
}

/// 附件名只允许「单层、.html 结尾、不含 ..」的文件名，防止跳出目录
fn check_asset_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("附件名为空".into());
    }
    if name.chars().count() > 120 {
        return Err("附件名过长".into());
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("非法的附件名".into());
    }
    if name.starts_with('.') {
        return Err("附件名不能以 . 开头".into());
    }
    if !name.to_lowercase().ends_with(".html") {
        return Err("只接受 .html 附件".into());
    }
    Ok(())
}

fn write_asset_in(dir: &Path, name: &str, content: &str) -> Result<(), String> {
    check_asset_name(name)?;
    fs::create_dir_all(dir).map_err(|e| format!("创建附件目录失败: {e}"))?;
    let path = dir.join(name);
    // 同样先写临时文件再改名，避免写一半断掉留下半个网页
    let tmp = path.with_extension("html.tmp");
    fs::write(&tmp, content).map_err(|e| format!("写入网页失败: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("保存网页失败: {e}"))?;
    Ok(())
}

fn read_asset_in(dir: &Path, name: &str) -> Result<String, String> {
    check_asset_name(name)?;
    let path = dir.join(name);
    if !path.exists() {
        return Err("这个网页文件不见了".into());
    }
    fs::read_to_string(&path).map_err(|e| format!("读取网页失败: {e}"))
}

/// 保存一份网页到 .assets，返回文件名（笔记里存的也是这个文件名）
#[tauri::command]
fn save_asset(app: tauri::AppHandle, name: String, content: String) -> Result<String, String> {
    write_asset_in(&asset_dir(&app)?, &name, &content)?;
    Ok(name)
}

#[tauri::command]
fn read_asset(app: tauri::AppHandle, name: String) -> Result<String, String> {
    read_asset_in(&asset_dir(&app)?, &name)
}

#[tauri::command]
fn delete_asset(app: tauri::AppHandle, name: String) -> Result<(), String> {
    check_asset_name(&name)?;
    let path = asset_dir(&app)?.join(&name);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("删除网页失败: {e}"))?;
    }
    Ok(())
}

/// 在浏览器里打开这份网页（用户想拿原文时用）
#[tauri::command]
fn open_asset(app: tauri::AppHandle, name: String) -> Result<(), String> {
    check_asset_name(&name)?;
    let path = asset_dir(&app)?.join(&name);
    if !path.exists() {
        return Err("这个网页文件不见了".into());
    }
    open_with_system(&path)
}

/// 正文里的普通 http(s) 外链，用系统默认浏览器打开。
/// 只放行 http/https，避免笔记里的链接被拿去执行本地命令。
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    let u = url.trim();
    if !(u.starts_with("http://") || u.starts_with("https://")) {
        return Err("只支持 http/https 链接".into());
    }
    open_with_system(Path::new(u))
}

/// 读取用户拖进窗口的外部文件（Tauri 的原生拖放只给路径，不给内容）
#[tauri::command]
fn read_external_file(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if p.extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_lowercase())
        .map(|s| s == "html" || s == "htm" || s == "xhtml")
        != Some(true)
    {
        return Err("只支持拖入 .html 网页文件".into());
    }
    let meta = fs::metadata(&p).map_err(|e| format!("读不到这个文件: {e}"))?;
    if meta.len() > 32 * 1024 * 1024 {
        return Err("网页太大了（超过 32MB）".into());
    }
    fs::read_to_string(&p).map_err(|e| format!("读取文件失败: {e}"))
}

/// 图片扩展名 → data URI 里的 MIME。只放行常见位图/矢量格式，
/// 免得把任意二进制（甚至可执行文件）读进来塞进笔记。
fn image_mime(ext: &str) -> Option<&'static str> {
    match ext.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "svg" => Some("image/svg+xml"),
        "avif" => Some("image/avif"),
        "heic" | "heif" => Some("image/heic"),
        "tif" | "tiff" => Some("image/tiff"),
        "ico" => Some("image/x-icon"),
        _ => None,
    }
}

/// 标准 base64（RFC 4648）。原生拖放只给路径，图片得读成二进制再交给前端，
/// 自己编码就不必为这一件事多拉一个 crate。
fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((n >> 18) & 63) as usize] as char);
        out.push(TABLE[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            TABLE[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// 读取从 Finder 拖进窗口的图片，返回可直接塞进 <img src> 的 data URI。
/// 前端会再按老规矩压到长边 1600 / WebP，所以这里不解码、不重采样。
#[tauri::command]
fn read_external_image(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    let ext = p.extension().and_then(|s| s.to_str()).unwrap_or("");
    let mime = image_mime(ext).ok_or_else(|| "只支持拖入常见图片文件".to_string())?;
    let meta = fs::metadata(&p).map_err(|e| format!("读不到这个文件: {e}"))?;
    if meta.len() > 25 * 1024 * 1024 {
        return Err("图片太大了（超过 25MB）".into());
    }
    let bytes = fs::read(&p).map_err(|e| format!("读取文件失败: {e}"))?;
    Ok(format!("data:{mime};base64,{}", base64_encode(&bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_base(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "jianji-test-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn 空的笔记本能删掉() {
        let base = temp_base("empty");
        fs::create_dir_all(base.join("工作")).unwrap();
        // .DS_Store 这种杂物不该阻止删除
        fs::write(base.join("工作/.DS_Store"), b"x").unwrap();
        assert!(remove_notebook_dir(&base, "工作", false).is_ok());
        assert!(!base.join("工作").exists());
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn 有笔记时非强制会拒绝() {
        let base = temp_base("hasnote");
        fs::create_dir_all(base.join("工作")).unwrap();
        fs::write(base.join("工作/周报.md"), "hi").unwrap();
        assert!(remove_notebook_dir(&base, "工作", false).is_err());
        assert!(base.join("工作/周报.md").exists());
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn 有笔记时强制能删掉() {
        let base = temp_base("force");
        fs::create_dir_all(base.join("工作")).unwrap();
        fs::write(base.join("工作/周报.md"), "hi").unwrap();
        assert!(remove_notebook_dir(&base, "工作", true).is_ok());
        assert!(!base.join("工作").exists());
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn 不存在的笔记本视作已删除() {
        let base = temp_base("missing");
        assert!(remove_notebook_dir(&base, "不存在", false).is_ok());
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn 非法名字被挡掉() {
        let base = temp_base("bad");
        assert!(remove_notebook_dir(&base, "../etc", true).is_err());
        assert!(remove_notebook_dir(&base, ".hidden", true).is_err());
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn 附件名挡住穿越和非网页() {
        assert!(check_asset_name("../逃出去.html").is_err());
        assert!(check_asset_name("/etc/passwd.html").is_err());
        assert!(check_asset_name(".隐藏.html").is_err());
        assert!(check_asset_name("笔记.md").is_err());
        assert!(check_asset_name("").is_err());
        assert!(check_asset_name("20261103-1413-ab12.html").is_ok());
        assert!(check_asset_name("大写.HTML").is_ok());
    }

    #[test]
    fn 附件写入后能原样读回() {
        let dir = temp_base("asset");
        let html = "<!doctype html><html><body><h1>月报</h1></body></html>";
        write_asset_in(&dir, "a.html", html).unwrap();
        assert_eq!(read_asset_in(&dir, "a.html").unwrap(), html);
        // 同名再写一次 = 覆盖，不留旧的 tmp
        write_asset_in(&dir, "a.html", "<h1>新</h1>").unwrap();
        assert_eq!(read_asset_in(&dir, "a.html").unwrap(), "<h1>新</h1>");
        assert!(!dir.join("a.html.tmp").exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 读不存在的附件会报错而不是空串() {
        let dir = temp_base("assetmiss");
        assert!(read_asset_in(&dir, "没有这个.html").is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn 外部拖入只认网页文件() {
        let dir = temp_base("drop");
        let html = dir.join("报表.html");
        fs::write(&html, "<h1>hi</h1>").unwrap();
        assert_eq!(
            read_external_file(html.to_string_lossy().to_string()).unwrap(),
            "<h1>hi</h1>"
        );
        let txt = dir.join("说明.txt");
        fs::write(&txt, "hi").unwrap();
        assert!(read_external_file(txt.to_string_lossy().to_string()).is_err());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn base64_编码符合标准() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64_encode(&[0xff, 0x00, 0x10]), "/wAQ");
    }

    #[test]
    fn 外部拖入图片返回可直接显示的_data_uri() {
        let dir = temp_base("dropimg");
        let png = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        let f = dir.join("截图.PNG");
        fs::write(&f, png).unwrap();
        let uri = read_external_image(f.to_string_lossy().to_string()).unwrap();
        assert!(uri.starts_with("data:image/png;base64,"));
        assert_eq!(uri, format!("data:image/png;base64,{}", base64_encode(&png)));

        let svg = dir.join("图.svg");
        fs::write(&svg, "<svg/>").unwrap();
        assert!(read_external_image(svg.to_string_lossy().to_string())
            .unwrap()
            .starts_with("data:image/svg+xml;base64,"));

        let txt = dir.join("说明.txt");
        fs::write(&txt, "hi").unwrap();
        assert!(read_external_image(txt.to_string_lossy().to_string()).is_err());
        assert!(read_external_image(dir.join("没有.png").to_string_lossy().to_string()).is_err());
        fs::remove_dir_all(&dir).ok();
    }
}
