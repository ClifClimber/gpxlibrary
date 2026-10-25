'use strict';
// Locates the docker CLI (Docker Desktop may be installed for all users or per user on Windows)
// and returns the environment it needs: its bin folder on PATH for the credential helpers.
const fs = require('fs');
const path = require('path');

function dockerBin() {
  const candidates = [
    process.env.DOCKER_BIN,
    process.platform === 'win32' && path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Docker', 'Docker', 'resources', 'bin', 'docker.exe'),
    process.platform === 'win32' && process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe'),
  ].filter(Boolean);
  return candidates.find(p => fs.existsSync(p)) || 'docker';
}

function dockerEnv(env = process.env) {
  const bin = dockerBin();
  if (!path.isAbsolute(bin)) return env;
  const key = Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH';
  return { ...env, [key]: path.dirname(bin) + path.delimiter + (env[key] || '') };
}

module.exports = { dockerBin, dockerEnv };
