#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::collections::HashMap;
use std::ffi::{CString, c_void};
use std::sync::atomic::{AtomicU32, Ordering};
use std::os::raw::c_int;

// libkrun C API bindings (simplified subset)
#[link(name = "krun")]
extern "C" {
    fn krun_create_ctx() -> u32;
    fn krun_free_ctx(ctx_id: u32) -> c_int;
    fn krun_set_vm_config(ctx_id: u32, num_vcpus: u8, ram_mib: u32) -> c_int;
    fn krun_set_root(ctx_id: u32, root_path: *const i8) -> c_int;
    fn krun_set_workdir(ctx_id: u32, workdir_path: *const i8) -> c_int;
    fn krun_set_exec(ctx_id: u32, exec_path: *const i8, argv: *const *const i8, envp: *const *const i8) -> c_int;
    fn krun_add_virtiofs(ctx_id: u32, tag: *const i8, path: *const i8) -> c_int;
    fn krun_set_port_map(ctx_id: u32, port_map: *const i8) -> c_int;
    fn krun_start_enter(ctx_id: u32) -> c_int;
}

static NEXT_CID: AtomicU32 = AtomicU32::new(3);

#[napi(object)]
pub struct LibkrunConfig {
    /// Number of virtual CPUs
    pub cpus: Option<u8>,
    /// Memory in MiB
    pub memory_mib: Option<u32>,
    /// Root filesystem path
    pub rootfs_path: String,
    /// Working directory inside VM
    pub workdir: Option<String>,
    /// virtiofs mounts: { tag: host_path }
    pub mounts: Option<HashMap<String, String>>,
    /// Port mappings: ["host:guest", ...]
    pub port_map: Option<Vec<String>>,
    /// Environment variables
    pub env: Option<HashMap<String, String>>,
}

#[napi(object)]
pub struct VmInfo {
    pub ctx_id: u32,
    pub cid: u32,
    pub cpus: u8,
    pub memory_mib: u32,
}

/// Check if libkrun is available on this system
#[napi]
pub fn is_available() -> bool {
    // Check if we can create a context (tests libkrun presence)
    #[cfg(target_os = "macos")]
    {
        unsafe {
            let ctx = krun_create_ctx();
            if ctx != u32::MAX {
                krun_free_ctx(ctx);
                return true;
            }
        }
        false
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Get libkrun version string
#[napi]
pub fn get_version() -> String {
    // libkrun doesn't expose version API, return build info
    "libkrun (macOS Virtualization.framework)".to_string()
}

/// Create a new libkrun VM context
#[napi]
pub fn create_context(config: LibkrunConfig) -> Result<VmInfo> {
    #[cfg(target_os = "macos")]
    {
        unsafe {
            let ctx_id = krun_create_ctx();
            if ctx_id == u32::MAX {
                return Err(Error::from_reason("Failed to create libkrun context"));
            }

            let cpus = config.cpus.unwrap_or(1);
            let memory_mib = config.memory_mib.unwrap_or(512);

            // Set VM config
            if krun_set_vm_config(ctx_id, cpus, memory_mib) != 0 {
                krun_free_ctx(ctx_id);
                return Err(Error::from_reason("Failed to set VM config"));
            }

            // Set root filesystem
            let rootfs = CString::new(config.rootfs_path.clone())
                .map_err(|_| Error::from_reason("Invalid rootfs path"))?;
            if krun_set_root(ctx_id, rootfs.as_ptr()) != 0 {
                krun_free_ctx(ctx_id);
                return Err(Error::from_reason("Failed to set rootfs"));
            }

            // Set working directory
            if let Some(workdir) = &config.workdir {
                let workdir_c = CString::new(workdir.clone())
                    .map_err(|_| Error::from_reason("Invalid workdir"))?;
                if krun_set_workdir(ctx_id, workdir_c.as_ptr()) != 0 {
                    krun_free_ctx(ctx_id);
                    return Err(Error::from_reason("Failed to set workdir"));
                }
            }

            // Add virtiofs mounts
            if let Some(mounts) = &config.mounts {
                for (tag, path) in mounts {
                    let tag_c = CString::new(tag.clone())
                        .map_err(|_| Error::from_reason("Invalid mount tag"))?;
                    let path_c = CString::new(path.clone())
                        .map_err(|_| Error::from_reason("Invalid mount path"))?;
                    if krun_add_virtiofs(ctx_id, tag_c.as_ptr(), path_c.as_ptr()) != 0 {
                        krun_free_ctx(ctx_id);
                        return Err(Error::from_reason(format!("Failed to add virtiofs mount: {}", tag)));
                    }
                }
            }

            // Set port mappings
            if let Some(port_map) = &config.port_map {
                let port_map_str = port_map.join(",");
                let port_map_c = CString::new(port_map_str)
                    .map_err(|_| Error::from_reason("Invalid port map"))?;
                if krun_set_port_map(ctx_id, port_map_c.as_ptr()) != 0 {
                    krun_free_ctx(ctx_id);
                    return Err(Error::from_reason("Failed to set port map"));
                }
            }

            let cid = NEXT_CID.fetch_add(1, Ordering::SeqCst);

            Ok(VmInfo {
                ctx_id,
                cid,
                cpus,
                memory_mib,
            })
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err(Error::from_reason("libkrun is only available on macOS"))
    }
}

/// Start the VM (blocking - runs in the current thread)
/// Note: krun_start_enter blocks, so this needs special handling
#[napi]
pub fn start_vm(ctx_id: u32) -> Result<i32> {
    #[cfg(target_os = "macos")]
    {
        unsafe {
            let result = krun_start_enter(ctx_id);
            Ok(result)
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err(Error::from_reason("libkrun is only available on macOS"))
    }
}

/// Free a VM context
#[napi]
pub fn free_context(ctx_id: u32) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        unsafe {
            if krun_free_ctx(ctx_id) != 0 {
                return Err(Error::from_reason("Failed to free context"));
            }
        }
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err(Error::from_reason("libkrun is only available on macOS"))
    }
}

/// Set the executable to run in the VM
#[napi]
pub fn set_exec(ctx_id: u32, exec_path: String, args: Vec<String>, env: HashMap<String, String>) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        unsafe {
            let exec_c = CString::new(exec_path)
                .map_err(|_| Error::from_reason("Invalid exec path"))?;

            // Build argv array
            let args_c: Vec<CString> = args.iter()
                .map(|a| CString::new(a.clone()).unwrap())
                .collect();
            let mut argv_ptrs: Vec<*const i8> = args_c.iter().map(|a| a.as_ptr()).collect();
            argv_ptrs.push(std::ptr::null());

            // Build envp array
            let env_strings: Vec<String> = env.iter()
                .map(|(k, v)| format!("{}={}", k, v))
                .collect();
            let env_c: Vec<CString> = env_strings.iter()
                .map(|e| CString::new(e.clone()).unwrap())
                .collect();
            let mut envp_ptrs: Vec<*const i8> = env_c.iter().map(|e| e.as_ptr()).collect();
            envp_ptrs.push(std::ptr::null());

            if krun_set_exec(ctx_id, exec_c.as_ptr(), argv_ptrs.as_ptr(), envp_ptrs.as_ptr()) != 0 {
                return Err(Error::from_reason("Failed to set exec"));
            }
        }
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err(Error::from_reason("libkrun is only available on macOS"))
    }
}
