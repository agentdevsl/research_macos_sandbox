fn main() {
    napi_build::setup();

    // Link to libkrun on macOS
    #[cfg(target_os = "macos")]
    {
        // Try to find libkrun in common locations
        let libkrun_paths = [
            "/opt/homebrew/lib",
            "/usr/local/lib",
            "/opt/libkrun/lib",
        ];

        for path in &libkrun_paths {
            if std::path::Path::new(&format!("{}/libkrun.dylib", path)).exists() {
                println!("cargo:rustc-link-search=native={}", path);
                break;
            }
        }

        println!("cargo:rustc-link-lib=dylib=krun");
    }
}
