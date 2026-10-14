use openmusic_core::MusicApp;
use serde_json::{json, Value};
use std::{io::{self, BufRead, Write}, path::PathBuf};
fn main() {
    if let Err(err) = run() { eprintln!("OpenMusic error: {err}"); std::process::exit(1); }
}
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let home=std::env::var_os("HOME").or_else(||std::env::var_os("USERPROFILE")).map(PathBuf::from).unwrap_or_else(||PathBuf::from("."));
    let dir=home.join(".openmusic"); std::fs::create_dir_all(&dir)?;
    let app=MusicApp::open(dir.join("library.sqlite"))?;
    let args:Vec<String>=std::env::args().skip(1).collect();
    if args.first().map(String::as_str)==Some("serve-stdio") {
        eprintln!("OpenMusic JSON command loop; send {{\"command\":\"music.status\",\"args\":{{}}}} per line");
        let stdin=io::stdin();
        for line in stdin.lock().lines() {
            let line=line?;
            let outcome=(|| -> Result<Value,Box<dyn std::error::Error>> {
                let request:Value=serde_json::from_str(&line)?;
                let command=request["command"].as_str().ok_or("Missing command")?;
                Ok(app.execute(command,request.get("args").cloned().unwrap_or(json!({})))?)
            })();
            let response=match outcome {Ok(data)=>json!({"ok":true,"data":data}),Err(e)=>json!({"ok":false,"error":e.to_string()})};
            println!("{}",response); io::stdout().flush()?;
        }
    } else {
        if args.is_empty(){eprintln!("Usage: openmusic-cli COMMAND [JSON_ARGS] | serve-stdio");return Ok(());}
        let arguments=if args.len()>1 {serde_json::from_str(&args[1])?}else{json!({})};
        let value=app.execute(&args[0],arguments)?;
        println!("{}",serde_json::to_string_pretty(&value)?);
        // Keep playback alive for this CLI process, if requested explicitly.
        if args[0]=="music.play" { eprintln!("Playing. Press Enter to stop."); let mut line=String::new();io::stdin().read_line(&mut line)?; }
    }
    Ok(())
}
