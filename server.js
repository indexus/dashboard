#!/usr/bin/env node
/**
 * Indexus mesh dashboard — protocol-only ops console.
 *
 * Talks to Indexus monitoring (:19000) and issuer (:22000). AWS lifecycle
 * actions use the AWS CLI from the dashboard host.
 *
 *   BOOT_IP=127.0.0.1 node server.js
 *   open http://127.0.0.1:3847/
 *
 * Env:
 *   BOOT_IP       bootstrap IP (default: probe 127.0.0.1)
 *   ISSUER_URL    issuer base URL (default http://{BOOT_IP}:22000)
 *   MON_PORT      monitoring port, default 19000
 *   PORT          dashboard listen port, default 3847
 *   POLL_MS       server-side poll interval, default 3000
 *   HISTORY_MS    rolling sample window, default 12m
 *   P2P_PROTOCOL  http|https for /api/p2p/:ip/:port fan-out (default http).
 *                 https needs INDEXUS_P2P_TLS=1 on the local mesh (HTTP/2).
 */
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { spawn as spawnProc } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  DVF_GEO_COLLECTION,
  DVF_PURCHASE_COLLECTION,
  defaultDvfDataDir,
  loadDvfPurchases,
} from "./lib/dvfLoader.js";
import {
  MESH_CONFIG_DEFAULTS,
  meshConfigEqual,
  meshConfigFromEnvText,
  meshConfigFromNode,
  meshConfigToEnv,
  normalizeMeshConfig,
} from "./lib/meshConfig.js";
import {
  createNetworkRegistry,
  uniqueNetworkId,
} from "./lib/networkRegistry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, "dist");
const PUBLIC = path.join(__dirname, "public");
const CORE_ROOT = process.env.INDEXUS_CORE_ROOT
  ? path.resolve(process.env.INDEXUS_CORE_ROOT)
  : path.resolve(__dirname, "../core");
const LOCAL_DATA_DIR = path.join(CORE_ROOT, ".data-local");
const LOCAL_SNAPSHOT_DIR = path.join(LOCAL_DATA_DIR, "snapshots");
const LOCAL_TERMINATE = path.join(CORE_ROOT, "scripts", "local", "terminate.sh");
const LOCAL_MESH_UP = path.join(CORE_ROOT, "scripts", "local", "mesh_up.sh");
const DEFAULT_P2P_PORT = parseInt(process.env.P2P_PORT || "21000", 10);
/** Backend scheme for the Aggregate same-origin peer gateway. */
const P2P_PROTOCOL =
  process.env.P2P_PROTOCOL === "https" || process.env.INDEXUS_P2P_TLS === "1"
    ? "https"
    : "http";

const p2pHttpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 128,
  maxFreeSockets: 64,
});
const p2pHttpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 128,
  maxFreeSockets: 64,
  // Local mesh uses a lab self-signed cert when INDEXUS_P2P_TLS=1.
  rejectUnauthorized: false,
});

/** @type {{ running: boolean, startedAt: number|null, log: string, error: string|null, ok: boolean|null }} */
const remeshJob = {
  running: false,
  startedAt: null,
  log: "",
  error: null,
  ok: null,
};

/** @type {{ running: boolean, abort: boolean, paused: boolean, progress: object|null, result: object|null, error: string|null, startedAt: number|null }} */
const dvfJob = {
  running: false,
  abort: false,
  paused: false,
  progress: null,
  result: null,
  error: null,
  startedAt: null,
};

function staticRoot() {
  if (process.env.NODE_ENV === "production") return DIST;
  if (fs.existsSync(path.join(DIST, "index.html"))) return DIST;
  return PUBLIC;
}

const DEFAULT_MON_PORT = parseInt(process.env.MON_PORT || "19000", 10);
const PORT = parseInt(process.env.PORT || "3847", 10);
const POLL_MS = parseInt(process.env.POLL_MS || "3000", 10);
const HISTORY_MS = parseInt(process.env.HISTORY_MS || String(12 * 60 * 1000), 10);

const NETWORKS_FILE =
  process.env.INDEXUS_NETWORKS_FILE ||
  path.join(LOCAL_DATA_DIR, "dashboard-networks.json");
const networks = createNetworkRegistry(NETWORKS_FILE, {
  id: process.env.NETWORK_ID || "indexus-aws",
  label: process.env.NETWORK_LABEL || process.env.NETWORK_ID || "Indexus AWS",
  kind:
    !process.env.BOOT_IP || isLoopback(process.env.BOOT_IP || "")
      ? "local"
      : "aws",
  boot_ip: process.env.BOOT_IP || "",
  issuer_url: process.env.ISSUER_URL || "",
  mon_port: DEFAULT_MON_PORT,
  p2p_port: DEFAULT_P2P_PORT,
  run_dir: LOCAL_DATA_DIR,
  snapshot_dir: LOCAL_SNAPSHOT_DIR,
});
let activeNetwork = networks.active();
let bootIp = activeNetwork?.boot_ip || "";
let issuerURL = (activeNetwork?.issuer_url || "").replace(/\/$/, "");
let monPort = activeNetwork?.mon_port || DEFAULT_MON_PORT;
let p2pPort = activeNetwork?.p2p_port || DEFAULT_P2P_PORT;
let cache = null;
let pollError = null;
/** @type {Array<Record<string, unknown>>} */
const history = [];

function activateNetwork(entry) {
  activeNetwork = entry || null;
  bootIp = entry?.boot_ip || "";
  issuerURL = (entry?.issuer_url || "").replace(/\/$/, "");
  monPort = entry?.mon_port || DEFAULT_MON_PORT;
  p2pPort = entry?.p2p_port || DEFAULT_P2P_PORT;
  cache = null;
  pollError = null;
  history.length = 0;
}

function activeRunDir() {
  return activeNetwork?.run_dir || LOCAL_DATA_DIR;
}

function activeSnapshotDir() {
  return activeNetwork?.snapshot_dir || path.join(activeRunDir(), "snapshots");
}

function activeMeshConfigPath() {
  return path.join(activeRunDir(), "mesh-config.env");
}

function isLoopback(ip) {
  return ip === "127.0.0.1" || ip === "localhost" || ip === "::1";
}

function resolveIssuer() {
  if (issuerURL) return issuerURL;
  if (bootIp) return `http://${bootIp}:22000`;
  return "";
}

async function fetchJson(url, timeoutMs = 4000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }
    if (!res.ok) {
      const err = new Error(body?.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  } finally {
    clearTimeout(t);
  }
}

async function postJson(url, payload, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload ?? {}),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }
    if (!res.ok) {
      const err = new Error(body?.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = body;
      throw err;
    }
    return body;
  } finally {
    clearTimeout(t);
  }
}

/** Run scripts/local/terminate.sh with LEAVE=0 (no SoftLeave). */
function runLocalTerminate(instanceId) {
  return new Promise((resolve, reject) => {
    const child = spawnProc(LOCAL_TERMINATE, [instanceId], {
      env: { ...process.env, LEAVE: "0" },
      cwd: CORE_ROOT,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
        return;
      }
      reject(
        new Error(
          stderr.trim() || stdout.trim() || `terminate.sh exited ${code}`,
        ),
      );
    });
  });
}

function runCommand(command, args, { env = {}, cwd = CORE_ROOT, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProc(command, args, {
      cwd,
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
        return;
      }
      reject(new Error(stderr.trim() || stdout.trim() || `${command} exited ${code}`));
    });
  });
}

function localNetworkEnv(entry, { keepSnapshots = true } = {}) {
  const runDir =
    entry.run_dir || path.join(CORE_ROOT, `.data-network-${entry.id}`);
  const snapshotDir =
    entry.snapshot_dir || path.join(runDir, "snapshots");
  return {
    INDEXUS_RUN_DIR: runDir,
    NETWORK_ID: entry.id,
    BOOT_MON: String(entry.mon_port),
    BOOT_P2P: String(entry.p2p_port),
    ISSUER_URL: entry.issuer_url || "http://127.0.0.1:22000",
    SNAPSHOT_DIR: snapshotDir,
    INDEXUS_SNAPSHOT_DIR: snapshotDir,
    MESH_CONFIG: path.join(runDir, "mesh-config.env"),
    KEEP_SNAPSHOTS: keepSnapshots ? "1" : "0",
  };
}

async function saveNetworkSnapshots() {
  const targets = (cache?.nodes || [])
    .filter((node) => node.up)
    .map((node) => ({ ip: node.ip, mon: node.mon }));
  if (targets.length === 0 && bootIp) targets.push({ ip: bootIp, mon: monPort });
  const results = await Promise.all(
    targets.map(async (target) => {
      try {
        const out = await postJson(
          `http://${target.ip}:${target.mon}/checkpoint`,
          {},
          60000,
        );
        return { ...target, ok: true, ...out };
      } catch (error) {
        return { ...target, ok: false, error: error.message || String(error) };
      }
    }),
  );
  return results;
}

async function sleepLocalNetwork(entry) {
  const checkpoints = await saveNetworkSnapshots();
  if (checkpoints.some((result) => !result.ok)) {
    throw new Error("checkpoint failed; network was left awake");
  }
  const script = path.join(CORE_ROOT, "scripts", "local", "mesh_down.sh");
  await runCommand("bash", [script], { env: localNetworkEnv(entry) });
  return networks.upsert({ ...entry, state: "asleep" });
}

async function wakeLocalNetwork(entry) {
  const script = path.join(CORE_ROOT, "scripts", "local", "mesh_up.sh");
  const updated = networks.upsert({
    ...entry,
    boot_ip: "127.0.0.1",
    issuer_url: entry.issuer_url || "http://127.0.0.1:22000",
    state: "awake",
  });
  await runCommand("bash", [script], {
    env: localNetworkEnv(updated, { keepSnapshots: true }),
    timeoutMs: 300000,
  });
  return updated;
}

const AWS_REGION =
  process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "eu-west-3";
const TERRAFORM_DIR = path.join(CORE_ROOT, "scripts", "deploy", "terraform");
const BOOTSTRAP_USERDATA_TPL = path.join(
  TERRAFORM_DIR,
  "userdata_bootstrap.sh.tftpl",
);
const AWS_PLATFORM_PROJECT = process.env.AWS_PLATFORM_PROJECT || "indexus-aws";

async function terraformOutput(name, env = {}) {
  const out = await runCommand(
    "terraform",
    ["output", "-raw", name],
    { cwd: TERRAFORM_DIR, env: { AWS_REGION, ...env }, timeoutMs: 30000 },
  );
  return out.stdout.trim();
}

function parseTfAssignment(file, key) {
  try {
    const text = fs.readFileSync(file, "utf8");
    const match = text.match(
      new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"]+)"|([^\\s#]+))`, "m"),
    );
    return (match?.[1] || match?.[2] || "").trim();
  } catch {
    return "";
  }
}

/** Minimal terraform templatefile substitute for the bootstrap userdata tpl. */
function renderBootstrapUserdata(vars) {
  let tpl = fs.readFileSync(BOOTSTRAP_USERDATA_TPL, "utf8");
  // Terraform `$${` → literal `${` in the rendered script.
  tpl = tpl.replace(/\$\$\{/g, "\u0000{");
  for (const [key, value] of Object.entries(vars)) {
    tpl = tpl.split(`\${${key}}`).join(String(value));
  }
  if (/\$\{[a-z_]+\}/.test(tpl)) {
    throw new Error("bootstrap userdata still has unresolved template vars");
  }
  return tpl.replace(/\u0000\{/g, "${");
}

/**
 * Shared AWS platform (SG / IAM / LT / bucket / AMI) from the one Terraform
 * stack. Creating a network only spins an additional bootstrap EC2.
 */
async function loadAwsPlatform() {
  if (!fs.existsSync(TERRAFORM_DIR)) {
    throw new Error("AWS platform terraform is unavailable");
  }
  const bucket = await terraformOutput("artifacts_bucket");
  const launchTemplateId = await terraformOutput("launch_template_id");
  const ltOut = await runCommand(
    "aws",
    [
      "ec2",
      "describe-launch-template-versions",
      "--region",
      AWS_REGION,
      "--launch-template-id",
      launchTemplateId,
      "--versions",
      "$Latest",
      "--query",
      "LaunchTemplateVersions[0].LaunchTemplateData",
      "--output",
      "json",
    ],
    { timeoutMs: 30000 },
  );
  const lt = JSON.parse(ltOut.stdout || "{}");
  const tfvars = path.join(TERRAFORM_DIR, "terraform.tfvars");
  const amiFile = path.join(TERRAFORM_DIR, "ami.auto.tfvars");
  const subnetId =
    lt.NetworkInterfaces?.[0]?.SubnetId ||
    parseTfAssignment(tfvars, "public_subnet_id");
  const securityGroupIds = [
    ...(Array.isArray(lt.SecurityGroupIds) ? lt.SecurityGroupIds : []),
    ...(Array.isArray(lt.NetworkInterfaces?.[0]?.Groups)
      ? lt.NetworkInterfaces[0].Groups.map((group) =>
          typeof group === "string" ? group : group.GroupId,
        )
      : []),
  ].filter(Boolean);
  const uniqueSgs = [...new Set(securityGroupIds)];
  const profile =
    lt.IamInstanceProfile?.Name ||
    (lt.IamInstanceProfile?.Arn || "").split("/").pop() ||
    "";
  const amiId =
    parseTfAssignment(amiFile, "ami_id") ||
    parseTfAssignment(amiFile, "bootstrap_ami_id") ||
    lt.ImageId ||
    "";
  if (!subnetId || !uniqueSgs.length || !profile || !amiId) {
    throw new Error(
      "AWS platform incomplete — need subnet, security group, instance profile and AMI from terraform/launch template",
    );
  }
  return {
    project: AWS_PLATFORM_PROJECT,
    region: AWS_REGION,
    bucket,
    launchTemplateId,
    subnetId,
    securityGroupIds: uniqueSgs,
    profile,
    amiId,
    keyName: lt.KeyName || "",
    instanceType: lt.InstanceType || "t3.micro",
    spawnMax: parseTfAssignment(tfvars, "spawn_max") || "30",
    queuePressure: parseTfAssignment(tfvars, "queue_pressure") || "200",
    pressureHold: parseTfAssignment(tfvars, "pressure_hold") || "15s",
    scaleWindow: parseTfAssignment(tfvars, "scale_window") || "1m",
    scaleDownThreshold:
      parseTfAssignment(tfvars, "scale_down_threshold") || "200",
    scaleDownHold: parseTfAssignment(tfvars, "scale_down_hold") || "8m",
    scaleCooldown: parseTfAssignment(tfvars, "scale_cooldown") || "3m",
    downCooldown: parseTfAssignment(tfvars, "down_cooldown") || "2m",
    delegation: parseTfAssignment(tfvars, "delegation") || "5000",
  };
}

/** Spin one bootstrap EC2 for this network id — no new S3/IAM/SG stack. */
async function provisionAwsNetwork(input) {
  const id = String(input.id || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(id)) {
    throw new Error("network id must be valid before AWS bootstrap spin-up");
  }
  if (!fs.existsSync(BOOTSTRAP_USERDATA_TPL)) {
    throw new Error("bootstrap userdata template is missing");
  }
  const platform = await loadAwsPlatform();
  const userdata = renderBootstrapUserdata({
    bucket: platform.bucket,
    network_id: id,
    region: platform.region,
    project: platform.project,
    delegation: platform.delegation,
    launch_template_id: platform.launchTemplateId,
    spawn_max: platform.spawnMax,
    queue_pressure: platform.queuePressure,
    pressure_hold: platform.pressureHold,
    scale_window: platform.scaleWindow,
    scale_down_threshold: platform.scaleDownThreshold,
    scale_down_hold: platform.scaleDownHold,
    scale_cooldown: platform.scaleCooldown,
    down_cooldown: platform.downCooldown,
  });
  const userdataFile = path.join(
    CORE_ROOT,
    `.data-local`,
    `userdata-${id}.sh`,
  );
  fs.mkdirSync(path.dirname(userdataFile), { recursive: true });
  fs.writeFileSync(userdataFile, userdata, "utf8");

  const tagSpec = JSON.stringify([
    {
      ResourceType: "instance",
      Tags: [
        { Key: "Name", Value: `${id}-bootstrap` },
        { Key: "Role", Value: "bootstrap-issuer" },
        { Key: "Network", Value: id },
        { Key: "Project", Value: platform.project },
      ],
    },
  ]);
  const runArgs = [
    "ec2",
    "run-instances",
    "--region",
    platform.region,
    "--image-id",
    platform.amiId,
    "--instance-type",
    platform.instanceType,
    "--subnet-id",
    platform.subnetId,
    "--security-group-ids",
    ...platform.securityGroupIds,
    "--iam-instance-profile",
    `Name=${platform.profile}`,
    ...(platform.keyName ? ["--key-name", platform.keyName] : []),
    "--associate-public-ip-address",
    "--user-data",
    `file://${userdataFile}`,
    "--tag-specifications",
    tagSpec,
    "--query",
    "Instances[0].InstanceId",
    "--output",
    "text",
  ];
  const launched = await runCommand("aws", runArgs, { timeoutMs: 120000 });
  const instanceId = launched.stdout.trim();
  if (!instanceId || instanceId === "None") {
    throw new Error("AWS run-instances did not return an instance id");
  }

  await runCommand(
    "aws",
    [
      "ec2",
      "wait",
      "instance-running",
      "--region",
      platform.region,
      "--instance-ids",
      instanceId,
    ],
    { timeoutMs: 300000 },
  );

  let bootIP = "";
  for (let attempt = 0; attempt < 40; attempt++) {
    const ipOut = await runCommand("aws", [
      "ec2",
      "describe-instances",
      "--region",
      platform.region,
      "--instance-ids",
      instanceId,
      "--query",
      "Reservations[0].Instances[0].PublicIpAddress",
      "--output",
      "text",
    ]);
    bootIP = ipOut.stdout.trim();
    if (bootIP && bootIP !== "None") break;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  if (!bootIP || bootIP === "None") {
    throw new Error(`bootstrap ${instanceId} has no public IP`);
  }

  const issuer = `http://${bootIP}:22000`;
  let issuerReady = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      await fetchJson(`${issuer}/health`, 3000);
      issuerReady = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  if (!issuerReady) {
    throw new Error(
      `bootstrap ${instanceId} is up (${bootIP}) but issuer did not become healthy`,
    );
  }
  return {
    boot_ip: bootIP,
    issuer_url: issuer,
    project: platform.project,
    bootstrap_instance_id: instanceId,
    state: "awake",
  };
}

async function awsInstances(entry, states = ["pending", "running", "stopping", "stopped"]) {
  const networkTag = entry.id;
  const result = await runCommand(
    "aws",
    [
      "ec2",
      "describe-instances",
      "--region",
      AWS_REGION,
      "--filters",
      `Name=tag:Network,Values=${networkTag}`,
      `Name=instance-state-name,Values=${states.join(",")}`,
      "--query",
      "Reservations[].Instances[].{id:InstanceId,ip:PublicIpAddress,role:Tags[?Key=='Role']|[0].Value,network:Tags[?Key=='Network']|[0].Value,state:State.Name}",
      "--output",
      "json",
    ],
    { timeoutMs: 30000 },
  );
  let parsed = JSON.parse(result.stdout || "[]");
  if (!Array.isArray(parsed) || !parsed.length) {
    // Backward-compat: older entries only had Project=<network id>.
    const fallback = await runCommand(
      "aws",
      [
        "ec2",
        "describe-instances",
        "--region",
        AWS_REGION,
        "--filters",
        `Name=tag:Project,Values=${entry.project || entry.id}`,
        `Name=instance-state-name,Values=${states.join(",")}`,
        "--query",
        "Reservations[].Instances[].{id:InstanceId,ip:PublicIpAddress,role:Tags[?Key=='Role']|[0].Value,network:Tags[?Key=='Network']|[0].Value,state:State.Name}",
        "--output",
        "json",
      ],
      { timeoutMs: 30000 },
    );
    parsed = JSON.parse(fallback.stdout || "[]");
  }
  return Array.isArray(parsed) ? parsed : [];
}

/** Spawneds that belong to this mesh — tagged Network, or untagged orphans on /registered. */
async function awsWorkerIdsForSleep(entry, bootstrap) {
  const ids = new Set();
  const tagged = await awsInstances(entry, ["pending", "running"]);
  for (const instance of tagged) {
    if (instance.id && instance.id !== bootstrap.id) ids.add(instance.id);
  }

  const registeredIPs = new Set();
  if (bootstrap.ip) {
    try {
      const reg = await fetchJson(
        `http://${bootstrap.ip}:${entry.mon_port || monPort}/registered`,
        3000,
      );
      const hosts = Array.isArray(reg) ? reg : reg?.hosts || [];
      for (const host of hosts) {
        const parsed = parseHost(host);
        if (parsed?.ip && parsed.ip !== bootstrap.ip) registeredIPs.add(parsed.ip);
      }
    } catch {
      /* ignore */
    }
  }

  const project = entry.project || AWS_PLATFORM_PROJECT;
  const spawnedOut = await runCommand(
    "aws",
    [
      "ec2",
      "describe-instances",
      "--region",
      AWS_REGION,
      "--filters",
      "Name=tag:Role,Values=spawned",
      `Name=tag:Project,Values=${project}`,
      "Name=instance-state-name,Values=pending,running",
      "--query",
      "Reservations[].Instances[].{id:InstanceId,ip:PublicIpAddress,network:Tags[?Key=='Network']|[0].Value}",
      "--output",
      "json",
    ],
    { timeoutMs: 30000 },
  );
  const spawned = JSON.parse(spawnedOut.stdout || "[]");
  for (const instance of Array.isArray(spawned) ? spawned : []) {
    if (!instance?.id) continue;
    const network = String(instance.network || "").trim();
    if (network === entry.id) {
      ids.add(instance.id);
      continue;
    }
    // Untagged legacy spawneds: only kill if they registered to this bootstrap.
    if (!network && registeredIPs.has(instance.ip)) ids.add(instance.id);
  }
  return [...ids];
}

async function sleepAwsNetwork(entry) {
  const checkpoints = await saveNetworkSnapshots();
  if (checkpoints.some((result) => !result.ok)) {
    throw new Error("checkpoint failed; AWS compute was left running");
  }
  const instances = await awsInstances(entry, ["pending", "running"]);
  const bootstrap =
    instances.find((instance) => instance.role === "bootstrap-issuer") ||
    instances.find((instance) => instance.ip === entry.boot_ip);
  if (!bootstrap?.id) throw new Error("AWS bootstrap instance not found");
  const workers = await awsWorkerIdsForSleep(entry, bootstrap);
  if (workers.length) {
    await runCommand("aws", [
      "ec2",
      "terminate-instances",
      "--region",
      AWS_REGION,
      "--instance-ids",
      ...workers,
    ]);
  }
  await runCommand("aws", [
    "ec2",
    "stop-instances",
    "--region",
    AWS_REGION,
    "--instance-ids",
    bootstrap.id,
  ]);
  return networks.upsert({
    ...entry,
    state: "asleep",
    bootstrap_instance_id: bootstrap.id,
  });
}

async function awsInstanceState(instanceId) {
  const out = await runCommand(
    "aws",
    [
      "ec2",
      "describe-instances",
      "--region",
      AWS_REGION,
      "--instance-ids",
      instanceId,
      "--query",
      "Reservations[0].Instances[0].{state:State.Name,ip:PublicIpAddress}",
      "--output",
      "json",
    ],
    { timeoutMs: 30000 },
  );
  try {
    return JSON.parse(out.stdout || "{}");
  } catch {
    return {};
  }
}

async function wakeAwsNetwork(entry) {
  let bootstrapID = entry.bootstrap_instance_id;
  if (!bootstrapID) {
    const instances = await awsInstances(entry);
    bootstrapID =
      instances.find((instance) => instance.role === "bootstrap-issuer")?.id || "";
  }
  if (!bootstrapID) throw new Error("AWS bootstrap instance not found");

  let info = await awsInstanceState(bootstrapID);
  let state = String(info.state || "");
  // Sleep returns as soon as stop-instances is accepted — the instance can
  // still be "stopping". StartInstances then fails with IncorrectInstanceState
  // and the UI shows a hard error / Failed to fetch via the vite proxy.
  if (state === "stopping" || state === "shutting-down") {
    await runCommand(
      "aws",
      [
        "ec2",
        "wait",
        "instance-stopped",
        "--region",
        AWS_REGION,
        "--instance-ids",
        bootstrapID,
      ],
      { timeoutMs: 300000 },
    );
    info = await awsInstanceState(bootstrapID);
    state = String(info.state || "");
  }

  if (state === "pending" || state === "running") {
    // Already coming up (double-click wake, or sleep never finished stop).
  } else if (state === "stopped") {
    await runCommand("aws", [
      "ec2",
      "start-instances",
      "--region",
      AWS_REGION,
      "--instance-ids",
      bootstrapID,
    ]);
  } else {
    throw new Error(
      `AWS bootstrap ${bootstrapID} is ${state || "unknown"} — cannot wake`,
    );
  }

  await runCommand(
    "aws",
    [
      "ec2",
      "wait",
      "instance-running",
      "--region",
      AWS_REGION,
      "--instance-ids",
      bootstrapID,
    ],
    { timeoutMs: 300000 },
  );

  // Public IP can lag a few seconds after running.
  let nextIP = "";
  for (let i = 0; i < 30; i++) {
    info = await awsInstanceState(bootstrapID);
    nextIP = String(info.ip || "").trim();
    if (nextIP && nextIP !== "None") break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (!nextIP || nextIP === "None") {
    throw new Error("AWS bootstrap has no public IP after start");
  }

  // Issuer systemd starts after cloud-init; wait so the dashboard does not
  // mark awake while /token still fails.
  const issuer = `http://${nextIP}:22000`;
  let healthy = false;
  for (let i = 0; i < 60; i++) {
    try {
      await fetchJson(`${issuer}/health`, 3000);
      healthy = true;
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
  if (!healthy) {
    throw new Error(`issuer not healthy at ${issuer} after wake`);
  }

  return networks.upsert({
    ...entry,
    boot_ip: nextIP,
    issuer_url: issuer,
    bootstrap_instance_id: bootstrapID,
    state: "awake",
  });
}

async function sleepNetwork(entry) {
  return entry.kind === "local"
    ? sleepLocalNetwork(entry)
    : sleepAwsNetwork(entry);
}

async function wakeNetwork(entry) {
  return entry.kind === "local"
    ? wakeLocalNetwork(entry)
    : wakeAwsNetwork(entry);
}

function readMeshConfigFile() {
  const file = activeMeshConfigPath();
  try {
    if (!fs.existsSync(file)) return null;
    return meshConfigFromEnvText(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeMeshConfigFile(cfg) {
  const file = activeMeshConfigPath();
  const normalized = normalizeMeshConfig(cfg);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, meshConfigToEnv(normalized), "utf8");
  return normalized;
}

function liveMeshConfig() {
  const nodes = cache?.nodes || [];
  const boot =
    nodes.find((n) => n.up && n.role === "bootstrap") ||
    nodes.find((n) => n.up) ||
    null;
  return meshConfigFromNode(boot);
}

function startRemesh({ keepSnapshots = false } = {}) {
  if (remeshJob.running) {
    const err = new Error("remesh already running");
    err.status = 409;
    throw err;
  }
  if (!fs.existsSync(LOCAL_MESH_UP)) {
    const err = new Error("mesh_up.sh not found");
    err.status = 503;
    throw err;
  }
  remeshJob.running = true;
  remeshJob.startedAt = Date.now();
  remeshJob.log = "";
  remeshJob.error = null;
  remeshJob.ok = null;

  // Clean & Restart: delete object-store snapshots before mesh_up so a
  // leftover DirStore (zones/, nodes/) cannot resurrect after reboot.
  if (!keepSnapshots) {
    const snapshotDir = activeSnapshotDir();
    try {
      fs.rmSync(snapshotDir, { recursive: true, force: true });
      remeshJob.log += `wiped ${snapshotDir}\n`;
    } catch (e) {
      remeshJob.log += `snapshot wipe warning: ${e.message || e}\n`;
    }
  }

  const child = spawnProc("bash", [LOCAL_MESH_UP], {
    cwd: CORE_ROOT,
    env: {
      ...process.env,
      // Force the remesh intent — do not inherit a stale KEEP_SNAPSHOTS=1.
      KEEP_SNAPSHOTS: keepSnapshots ? "1" : "0",
      ...localNetworkEnv(activeNetwork, { keepSnapshots }),
    },
  });
  const append = (buf) => {
    remeshJob.log = (remeshJob.log + buf.toString()).slice(-24000);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.on("error", (e) => {
    remeshJob.running = false;
    remeshJob.ok = false;
    remeshJob.error = e.message || String(e);
  });
  child.on("close", (code) => {
    remeshJob.running = false;
    remeshJob.ok = code === 0;
    if (code !== 0) {
      remeshJob.error =
        remeshJob.error ||
        `mesh_up.sh exited ${code}`;
    }
  });
  return remeshJob;
}

async function probeLocalBoot() {
  try {
    await fetchJson(`http://127.0.0.1:${monPort}/health`, 1500);
    return "127.0.0.1";
  } catch {
    return "";
  }
}

/** Optional local-lab mon port map from spawn metadata (not AWS). */
function localMonByIP() {
  /** @type {Map<string, { mon: number, id: string, prefer_near: string|null }>} */
  const map = new Map();
  const spawnedDir = path.join(activeRunDir(), "spawned");
  try {
    if (!fs.existsSync(spawnedDir)) return map;
    for (const name of fs.readdirSync(spawnedDir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(spawnedDir, name), "utf8"));
        const ip = meta.ip || meta.public_ip || "127.0.0.1";
        const mon = parseInt(meta.mon || meta.mon_port || monPort, 10);
        map.set(ip === "0.0.0.0" ? "127.0.0.1" : ip, {
          mon: Number.isFinite(mon) ? mon : monPort,
          id: meta.id || meta.name || name.replace(/\.json$/, ""),
          prefer_near: meta.prefer_near || meta.PreferNear || null,
        });
        // Local spawned often share loopback with distinct mon ports — key by mon too.
        if (meta.mon || meta.mon_port) {
          map.set(`127.0.0.1:${mon}`, {
            mon,
            id: meta.id || meta.name || name.replace(/\.json$/, ""),
            prefer_near: meta.prefer_near || meta.PreferNear || null,
          });
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return map;
}

function parseHost(h) {
  if (typeof h !== "string") return null;
  const m = h.match(/^([^@]+)@([^|]+)\|(\d+)/);
  if (!m) return null;
  return { name: m[1], ip: m[2], p2p: parseInt(m[3], 10) };
}

/** Local convention: mon 19000 → p2p 21000 (offset +2000). */
function p2pFromMon(mon) {
  if (mon == null || Number.isNaN(Number(mon))) return p2pPort;
  return Number(mon) + 2000;
}

function round1(v) {
  if (v == null || Number.isNaN(Number(v))) return null;
  return Math.round(Number(v) * 10) / 10;
}

/** Matches core/encoding BASE64.IDLength() (NewBase(64, 96)). */
const BASE64_ID_LEN = 16;

/** Pad a zone location / PreferNear id to full BASE64 length. */
function locationToNearKey(location) {
  if (location == null || location === "" || location === "@") return "";
  let key = String(location);
  while (key.length < BASE64_ID_LEN) key += "0";
  if (key.length > BASE64_ID_LEN) key = key.slice(0, BASE64_ID_LEN);
  return key;
}

/**
 * PreferNear hint for manual spawn: last load-split decision → node name.
 */
async function resolvePreferNear(ip, mon, fallbackName = "") {
  try {
    const status = await fetchJson(`http://${ip}:${mon}/status`, 3500);
    const a = status?.autoscale || {};
    if (a.last_prefer_near) {
      return {
        prefer_near: a.last_prefer_near,
        source: "load_split",
      };
    }
  } catch (_) {
    /* fall through */
  }
  const nameKey = locationToNearKey(fallbackName) || fallbackName || "";
  return {
    prefer_near: nameKey,
    source: nameKey ? "name" : "empty",
  };
}

function nodeFromStatus(ip, status, monPort, extra = {}) {
  const p2p = extra.p2p || p2pFromMon(monPort);
  if (!status) {
    return {
      ip,
      mon: monPort,
      p2p,
      host: `${ip}|${p2p}`,
      up: false,
      name: extra.name || null,
      role: extra.role || null,
      instance_id: extra.instance_id || null,
      prefer_near: extra.prefer_near || null,
      prefer_near_key: null,
    };
  }
  const a = status.autoscale || {};
  const p = a.pressure || {};
  const snap = status.snapshot || {};
  const preferNearKey = a.last_prefer_near || null;
  return {
    ip,
    mon: monPort,
    p2p,
    host: `${ip}|${p2p}`,
    up: true,
    local: isLoopback(ip),
    name: status.name || extra.name || null,
    role: a.role || extra.role || null,
    version: status.version || null,
    collections: status.collections ?? null,
    items: status.items ?? null,
    held: status.held ?? 0,
    zones: status.zones ?? null,
    peers: status.peers ?? null,
    queue: p.queue ?? status.queue ?? null,
    hot_signal: p.hot_signal || "",
    /** Last load-split PreferNear (weighted zone dichotomy). */
    prefer_near_key: preferNearKey,
    cpu_pct: round1(p.cpu_pct),
    mem_pct: round1(p.mem_pct),
    mem_projected: round1(p.mem_projected),
    disk_free_pct: round1(p.disk_free_pct),
    inserts_window: p.inserts_window ?? a.inserts_window ?? null,
    last_reason: a.last_reason || "",
    admit_blocked: !!a.admit_blocked,
    rising_fast: !!a.rising_fast,
    scale_ups_done: a.scale_ups_done ?? 0,
    up_in_flight: !!a.up_in_flight,
    down_in_flight: !!a.down_in_flight,
    items_limit: a.items_limit ?? null,
    queue_abs: a.queue_abs ?? null,
    disk_min_free: a.disk_min_free ?? null,
    leaving: !!status.leaving,
    write_ready: status.write_ready !== false,
    rebalancing: !!status.rebalancing,
    /** S3 / DirStore snapshot-delegation protocol enabled (bool). */
    delegation: snap.delegation ?? null,
    /** Soft item count before Own split (-delegation / INDEXUS_DELEGATION). */
    delegation_size: snap.delegation_size ?? null,
    /** Zones at/above this count use snapshot handoff (INDEXUS_TRANSFER_THRESHOLD). */
    transfer_threshold: snap.transfer_threshold ?? null,
    delegation_timeout: snap.delegation_timeout ?? null,
    transfer_timeout: snap.transfer_timeout ?? null,
    deleg_in: snap.deleg_in ?? 0,
    deleg_out: snap.deleg_out ?? 0,
    transferring:
      !!status.rebalancing ||
      (snap.deleg_in ?? 0) > 0 ||
      (snap.deleg_out ?? 0) > 0,
    store: !!snap.store,
    snap_dirty: snap.dirty ?? 0,
    snap_zones: snap.snapped ?? 0,
    wal_segments: snap.wal_segments ?? 0,
    uptime_s: status.uptime_s ?? null,
    instance_id: extra.instance_id || null,
    prefer_near: a.last_prefer_near || extra.prefer_near || null,
    mem_limit_pct: a.mem_limit_pct ?? null,
    cpu_limit_pct: a.cpu_limit_pct ?? null,
    // Full autoscale snapshot for the Node config tab (thresholds, holds, …).
    autoscale: a,
  };
}

async function discoverPeerTargets(boot) {
  /** @type {Array<{ ip: string, mon: number, p2p?: number, name?: string, instance_id?: string, prefer_near?: string|null, role?: string }>} */
  const targets = [
    { ip: boot, mon: monPort, p2p: p2pPort, role: "bootstrap" },
  ];
  const local = localMonByIP();

  try {
    const reg = await fetchJson(`http://${boot}:${monPort}/registered`, 3000);
    const hosts = Array.isArray(reg) ? reg : reg?.hosts || [];
    for (const h of hosts) {
      const parsed = parseHost(h);
      if (!parsed?.ip || !parsed.p2p) continue;
      const ip = isLoopback(parsed.ip) ? "127.0.0.1" : parsed.ip;
      const p2p = parsed.p2p;
      // Prefer p2p from /registered; mon = p2p - 2000 locally (or look up spawn meta by mon).
      const monFromP2p = p2p - 2000;
      const meta =
        local.get(`${ip}:${monFromP2p}`) ||
        (!isLoopback(ip) ? local.get(ip) : null);
      const mon = meta?.mon || monFromP2p;

      const existing = targets.find((t) => t.ip === ip && t.p2p === p2p);
      if (existing) {
        if (parsed.name && !existing.name) existing.name = parsed.name;
        if (meta?.id && !existing.instance_id) existing.instance_id = meta.id;
        continue;
      }
      // Same mon collision (should not happen) — skip only if identical
      if (targets.some((t) => t.ip === ip && t.mon === mon && t.p2p === p2p)) continue;

      targets.push({
        ip,
        mon,
        p2p,
        name: parsed.name,
        instance_id: meta?.id || null,
        prefer_near: meta?.prefer_near || null,
        role:
          mon === monPort && (ip === boot || isLoopback(ip))
            ? "bootstrap"
            : "spawned",
      });
    }
  } catch {
    /* ignore */
  }

  // Local spawned not yet in /registered
  for (const [key, meta] of local) {
    if (!key.includes(":")) continue;
    const mon = meta.mon;
    const p2p = p2pFromMon(mon);
    if (targets.some((t) => t.ip === "127.0.0.1" && t.p2p === p2p)) continue;
    targets.push({
      ip: "127.0.0.1",
      mon,
      p2p,
      instance_id: meta.id,
      prefer_near: meta.prefer_near,
      role: "spawned",
    });
  }

  return targets;
}

async function sampleMesh() {
  if (!activeNetwork) {
    pollError = null;
    cache = {
      ts: new Date().toISOString(),
      network_id: null,
      state: "empty",
      boot: null,
      issuer: resolveIssuer(),
      error: null,
      nodes: [],
      hosts: [],
      snapshots: { available: false, objects: [] },
      totals: { answering: 0, items: 0, queue: 0, scale_ups: 0 },
      history: [],
    };
    return cache;
  }
  if (activeNetwork.state === "asleep") {
    pollError = null;
    cache = {
      ts: new Date().toISOString(),
      network_id: activeNetwork.id,
      state: "asleep",
      boot: bootIp || null,
      issuer: resolveIssuer(),
      error: null,
      nodes: [],
      hosts: [],
      snapshots: { available: false, objects: [] },
      totals: { answering: 0, items: 0, queue: 0, scale_ups: 0 },
      history: [],
    };
    return cache;
  }
  if (!bootIp && activeNetwork.kind === "local") {
    bootIp = await probeLocalBoot();
  }
  if (!bootIp) {
    pollError = "no bootstrap — set BOOT_IP or start a local mesh on :19000";
    cache = {
      ts: new Date().toISOString(),
      network_id: activeNetwork.id,
      state: activeNetwork.state,
      boot: null,
      issuer: resolveIssuer(),
      error: pollError,
      nodes: [],
      snapshots: { available: false, objects: [] },
      totals: { answering: 0, items: 0, queue: 0, scale_ups: 0 },
      history: [],
    };
    return cache;
  }

  const targets = await discoverPeerTargets(bootIp);
  const statuses = await Promise.all(
    targets.map(async (t) => {
      try {
        const status = await fetchJson(`http://${t.ip}:${t.mon}/status`, 3500);
        return { t, status, err: null };
      } catch (e) {
        return { t, status: null, err: String(e.message || e) };
      }
    }),
  );

  const nodes = statuses.map(({ t, status }) =>
    nodeFromStatus(t.ip, status, t.mon, {
      name: t.name,
      instance_id: t.instance_id,
      prefer_near: t.prefer_near,
      role: t.role,
      p2p: t.p2p || p2pFromMon(t.mon),
    }),
  );

  let answering = 0;
  let items = 0;
  let queue = 0;
  let scaleUps = 0;
  for (const n of nodes) {
    if (!n.up) continue;
    answering++;
    items += n.items || 0;
    queue += n.queue || 0;
    scaleUps += n.scale_ups_done || 0;
  }

  let issuerHealth = null;
  const issuer = resolveIssuer();
  if (issuer) {
    try {
      issuerHealth = await fetchJson(`${issuer}/health`, 2000);
    } catch (e) {
      issuerHealth = { error: String(e.message || e) };
    }
  }

  let snapshots = { available: false, objects: [] };
  try {
    snapshots = await fetchJson(`http://${bootIp}:${monPort}/snapshots`, 5000);
  } catch (e) {
    snapshots = { available: false, error: String(e.message || e), objects: [] };
  }

  const bootNode = nodes.find((n) => n.ip === bootIp && n.mon === monPort && n.up);
  const sample = {
    ts: Date.now(),
    answering,
    items,
    queue,
    scale_ups: scaleUps,
    mem_pct: bootNode?.mem_pct ?? null,
    cpu_pct: bootNode?.cpu_pct ?? null,
    mem_limit_pct: bootNode?.mem_limit_pct ?? null,
    cpu_limit_pct: bootNode?.cpu_limit_pct ?? null,
  };
  history.push(sample);
  const cutoff = Date.now() - HISTORY_MS;
  while (history.length && history[0].ts < cutoff) history.shift();

  pollError = answering === 0 ? "no nodes answering" : null;
  const hosts = [
    ...new Set(
      nodes
        .filter((n) => n.up && n.host)
        .map((n) => n.host),
    ),
  ];
  cache = {
    ts: new Date().toISOString(),
    network_id: activeNetwork.id,
    state: activeNetwork.state,
    boot: bootIp,
    issuer,
    issuer_health: issuerHealth,
    error: pollError,
    bootstrap: bootIp ? `${bootIp}|${p2pPort}` : null,
    hosts,
    nodes,
    snapshots,
    totals: { answering, items, queue, scale_ups: scaleUps },
    history: history.map((h) => ({ ...h })),
    autoscale: bootNode
      ? {
          mem_limit_pct: bootNode.mem_limit_pct,
          cpu_limit_pct: bootNode.cpu_limit_pct,
          items_limit: bootNode.items_limit,
          queue_abs: bootNode.queue_abs,
          disk_min_free: bootNode.disk_min_free,
        }
      : null,
  };
  return cache;
}

async function listNetworkViews() {
  const snapshot = networks.snapshot();
  const views = await Promise.all(
    snapshot.networks.map(async (entry) => {
      const selected = entry.id === snapshot.active;
      if (entry.state === "asleep") {
        return { ...entry, active: selected, state: "asleep", nodes: 0 };
      }
      if (selected && cache) {
        return {
          ...entry,
          active: true,
          state: (cache.totals?.answering || 0) > 0 ? "awake" : "unreachable",
          nodes: cache.totals?.answering || 0,
        };
      }
      if (!entry.boot_ip) {
        return { ...entry, active: selected, state: "unconfigured", nodes: 0 };
      }
      try {
        await fetchJson(
          `http://${entry.boot_ip}:${entry.mon_port || DEFAULT_MON_PORT}/health`,
          1200,
        );
        return { ...entry, active: selected, state: "awake", nodes: null };
      } catch {
        return { ...entry, active: selected, state: "unreachable", nodes: 0 };
      }
    }),
  );
  return { active: snapshot.active, networks: views };
}

async function pollLoop() {
  for (;;) {
    try {
      await sampleMesh();
    } catch (e) {
      pollError = String(e.message || e);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sendJSON(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

/**
 * Fan-out Aggregate/Nearby peer calls through one browser origin.
 *
 * Preferred:  /api/p2p/:ip/:port/sets|ping|... → {P2P_PROTOCOL}://ip:port/...
 * Legacy:     /api/p2p/:port/...               → {P2P_PROTOCOL}://{BOOT_IP}:port/...
 *
 * Encoding the peer IP is required on AWS (spawned nodes share :21000 on
 * distinct public IPs). Port-only routing silently re-hit the bootstrap and
 * broke navigation=direct IXS1 follows.
 */
function proxyP2p(req, res) {
  const raw = req.url || "/";
  // New: /api/p2p/{ip}/{port}/...
  let match = raw.match(/^\/api\/p2p\/([^/?]+)\/(\d+)(\/[^?]*)(\?.*)?$/);
  let ip;
  let port;
  let peerPath;
  let query;
  if (match) {
    try {
      ip = decodeURIComponent(match[1]);
    } catch {
      sendJSON(res, 400, { error: "invalid p2p host encoding" });
      return;
    }
    port = Number(match[2]);
    peerPath = match[3] || "/";
    query = match[4] || "";
  } else {
    // Legacy lab: /api/p2p/{port}/... → BOOT_IP
    match = raw.match(/^\/api\/p2p\/(\d+)(\/[^?]*)(\?.*)?$/);
    if (!match) {
      sendJSON(res, 400, { error: "expected /api/p2p/:ip/:port/..." });
      return;
    }
    ip = bootIp || "127.0.0.1";
    port = Number(match[1]);
    peerPath = match[2] || "/";
    query = match[3] || "";
  }
  if (!(port >= 1 && port <= 65535)) {
    sendJSON(res, 400, { error: "invalid p2p port" });
    return;
  }
  ip = String(ip || "").trim();
  // Strip brackets if a client passed an IPv6 literal; Node wants bare form.
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  if (!ip || ip.includes("/") || ip.includes("\\") || ip.includes(" ")) {
    sendJSON(res, 400, { error: "invalid p2p host" });
    return;
  }
  const lib = P2P_PROTOCOL === "https" ? https : http;
  const agent = P2P_PROTOCOL === "https" ? p2pHttpsAgent : p2pHttpAgent;
  const headers = { ...req.headers, host: `${ip}:${port}` };
  delete headers["connection"];
  delete headers["content-length"];

  const upstream = lib.request(
    {
      protocol: `${P2P_PROTOCOL}:`,
      hostname: ip,
      port,
      path: `${peerPath}${query}`,
      method: req.method,
      headers,
      agent,
      timeout: 60_000,
    },
    (up) => {
      const outHeaders = { ...up.headers };
      // Browser talks same-origin; still expose ingress hints for the SDK.
      res.writeHead(up.statusCode || 502, outHeaders);
      up.pipe(res);
    }
  );
  upstream.on("timeout", () => {
    upstream.destroy();
    if (!res.headersSent) sendJSON(res, 504, { error: "p2p upstream timeout" });
  });
  upstream.on("error", (err) => {
    if (!res.headersSent) {
      sendJSON(res, 502, {
        error: "p2p upstream unavailable",
        detail: err.code || err.message,
        target: `${P2P_PROTOCOL}://${ip}:${port}${peerPath}`,
      });
    }
  });
  req.pipe(upstream);
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || "/").split("?")[0];

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Indexus-Routing-Key"
  );
  res.setHeader(
    "Access-Control-Expose-Headers",
    "X-Indexus-Ingress-Name, X-Indexus-Ingress-IP, X-Indexus-Ingress-Port"
  );
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (url.startsWith("/api/p2p/")) {
      return proxyP2p(req, res);
    }

    if (url === "/api/networks" && req.method === "GET") {
      return sendJSON(res, 200, await listNetworkViews());
    }

    if (url === "/api/networks" && req.method === "POST") {
      const body = await readBody(req).catch(() => ({}));
      const kind = body.kind === "local" ? "local" : "aws";
      const label = String(body.label || "").trim();
      const existing = networks.snapshot().networks;
      const existingIds = existing.map((entry) => entry.id);
      const requestedId = String(body.id || "").trim();
      const networkID = requestedId
        ? requestedId
        : uniqueNetworkId(label, existingIds);
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(networkID)) {
        return sendJSON(res, 400, {
          error: label
            ? "label must yield a valid network id (letters, numbers, _ or -)"
            : "network label is required",
        });
      }
      if (existingIds.includes(networkID)) {
        return sendJSON(res, 409, {
          error: `network id "${networkID}" already exists`,
        });
      }
      const localSlot = existing.filter((entry) => entry.kind === "local").length;
      const runDir = path.join(CORE_ROOT, `.data-network-${networkID}`);
      if (
        kind === "aws" &&
        !body.provision &&
        !String(body.boot_ip || "").trim()
      ) {
        return sendJSON(res, 400, {
          error: "boot_ip is required, or choose AWS bootstrap spin-up",
        });
      }
      let created;
      try {
        const provisionInput = { ...body, id: networkID, label: label || networkID };
        const awsTarget =
          kind === "aws" && body.provision
            ? await provisionAwsNetwork(provisionInput)
            : {};
        if (
          kind === "local" &&
          activeNetwork?.kind === "local" &&
          activeNetwork.state !== "asleep"
        ) {
          const sleeping = await sleepLocalNetwork(activeNetwork);
          activateNetwork(sleeping);
        }
        created = networks.upsert({
          id: networkID,
          label: label || networkID,
          kind,
          project:
            awsTarget.project ||
            body.project ||
            (kind === "aws" ? AWS_PLATFORM_PROJECT : networkID),
          boot_ip:
            kind === "local"
              ? "127.0.0.1"
              : awsTarget.boot_ip || body.boot_ip,
          issuer_url:
            kind === "local"
              ? "http://127.0.0.1:22000"
              : awsTarget.issuer_url ||
                body.issuer_url ||
                `http://${body.boot_ip}:22000`,
          mon_port:
            kind === "local"
              ? DEFAULT_MON_PORT + localSlot * 100
              : body.mon_port || DEFAULT_MON_PORT,
          p2p_port:
            kind === "local"
              ? DEFAULT_P2P_PORT + localSlot * 100
              : body.p2p_port || DEFAULT_P2P_PORT,
          run_dir: kind === "local" ? runDir : null,
          snapshot_dir:
            kind === "local" ? path.join(runDir, "snapshots") : null,
          state: kind === "local" ? "asleep" : awsTarget.state || "awake",
          bootstrap_instance_id: awsTarget.bootstrap_instance_id || null,
          collections: body.collections,
        });
        networks.setActive(created.id);
        activateNetwork(created);
        if (kind === "local" && body.wake !== false) {
          created = await wakeNetwork(created);
          activateNetwork(created);
        }
        await sampleMesh().catch(() => null);
        return sendJSON(res, 201, { ok: true, network: created });
      } catch (error) {
        return sendJSON(res, error.status || 500, {
          error: error.message || String(error),
          network: created || null,
        });
      }
    }

    if (url === "/api/networks/active" && req.method === "POST") {
      const body = await readBody(req).catch(() => ({}));
      try {
        const entry = networks.setActive(String(body.id || "").trim());
        activateNetwork(entry);
        await sampleMesh().catch(() => null);
        return sendJSON(res, 200, { ok: true, network: entry });
      } catch (error) {
        return sendJSON(res, 404, { error: error.message || String(error) });
      }
    }

    const networkAction = url.match(
      /^\/api\/networks\/([A-Za-z0-9][A-Za-z0-9_-]{0,62})\/(sleep|wake|delete)$/,
    );
    if (networkAction && req.method === "POST") {
      const [, id, action] = networkAction;
      const entry = networks.get(id);
      if (!entry) return sendJSON(res, 404, { error: `unknown network ${id}` });
      try {
        if (action === "delete") {
          if (entry.state !== "asleep") {
            return sendJSON(res, 409, {
              error: "sleep the network before removing it from the registry",
            });
          }
          const removed = networks.remove(id);
          activateNetwork(networks.active());
          return sendJSON(res, 200, { ok: true, removed });
        }
        networks.setActive(id);
        activateNetwork(entry);
        if (action === "sleep") await sampleMesh().catch(() => null);
        const updated =
          action === "sleep"
            ? await sleepNetwork(entry)
            : await wakeNetwork(entry);
        activateNetwork(updated);
        await sampleMesh().catch(() => null);
        return sendJSON(res, 200, { ok: true, network: updated });
      } catch (error) {
        return sendJSON(res, error.status || 500, {
          error: error.message || String(error),
        });
      }
    }

    if (url === "/api/collections" && req.method === "GET") {
      return sendJSON(res, 200, {
        network_id: activeNetwork?.id || null,
        collections: activeNetwork?.collections || [],
      });
    }

    if (url === "/api/collections" && req.method === "POST") {
      if (!activeNetwork) {
        return sendJSON(res, 409, { error: "create a network first" });
      }
      const body = await readBody(req).catch(() => ({}));
      try {
        const collection = networks.addCollection(activeNetwork.id, body.name);
        activeNetwork = networks.active();
        return sendJSON(res, 201, {
          ok: true,
          network_id: activeNetwork.id,
          collection,
          collections: activeNetwork.collections,
        });
      } catch (error) {
        return sendJSON(res, 400, { error: error.message || String(error) });
      }
    }

    if (url === "/api/mesh" && req.method === "GET") {
      if (!cache) await sampleMesh();
      return sendJSON(res, 200, cache || { error: "warming" });
    }

    if (url === "/api/health" && req.method === "GET") {
      return sendJSON(res, 200, {
        ok: true,
        network_id: activeNetwork?.id || null,
        network_label: activeNetwork?.label || null,
        network_state: activeNetwork?.state || "empty",
        boot: bootIp || null,
        issuer: resolveIssuer(),
        mon_port: monPort,
        p2p_port: p2pPort,
        p2p_protocol: P2P_PROTOCOL,
        p2p_gateway: "/api/p2p",
        bootstrap: bootIp ? `${bootIp}|${p2pPort}` : null,
        poll_error: pollError,
        static_root: path.basename(staticRoot()),
      });
    }

    if (url === "/api/prefer-near" && req.method === "GET") {
      const q = new URL(req.url || "/", "http://local").searchParams;
      const ip = q.get("ip") || bootIp || "127.0.0.1";
      const mon = parseInt(q.get("mon") || String(monPort), 10) || monPort;
      const fallback =
        q.get("name") ||
        (cache?.nodes || []).find((n) => n.ip === ip && n.mon === mon)?.name ||
        "";
      try {
        const out = await resolvePreferNear(ip, mon, fallback);
        return sendJSON(res, 200, { ip, mon, ...out });
      } catch (e) {
        return sendJSON(res, 502, { error: e.message || String(e) });
      }
    }

    if (url === "/api/token" && req.method === "POST") {
      const issuer = resolveIssuer();
      if (!issuer) return sendJSON(res, 503, { error: "issuer unavailable" });
      const body = await readBody(req).catch(() => ({}));
      const scopes = Array.isArray(body.scopes) && body.scopes.length
        ? body.scopes
        : ["read", "write"];
      try {
        const out = await postJson(`${issuer}/v1/issue/token`, {
          client_id: body.client_id || `mesh-dash-${Date.now()}`,
          scopes,
        });
        return sendJSON(res, 200, out);
      } catch (e) {
        return sendJSON(res, e.status || 502, { error: e.message, detail: e.body || null });
      }
    }

    if (url === "/api/spawn" && req.method === "POST") {
      const body = await readBody(req);
      const issuer = resolveIssuer();
      if (!issuer) return sendJSON(res, 503, { error: "issuer unavailable — set ISSUER_URL or BOOT_IP" });
      const spawnCount = Math.max(1, Math.min(3, parseInt(body.spawn_count || 1, 10) || 1));
      const preferNear = body.prefer_near || "";
      const requester = body.requester_id || (cache?.nodes || []).find((n) => n.up)?.name || "dashboard";
      try {
        const out = await postJson(`${issuer}/v1/scale`, {
          requester_id: requester,
          spawn_count: spawnCount,
          prefer_near: preferNear || requester,
          reason: body.reason || "dashboard",
          local_inserts: 0,
          owned_zones: 0,
        });
        return sendJSON(res, 200, out);
      } catch (e) {
        return sendJSON(res, e.status || 502, { error: e.message, detail: e.body || null });
      }
    }

    if (url === "/api/mesh-config" && req.method === "GET") {
      const live = liveMeshConfig();
      const saved = readMeshConfigFile();
      const draft = saved || live;
      return sendJSON(res, 200, {
        live,
        saved,
        draft,
        defaults: MESH_CONFIG_DEFAULTS,
        dirty: !meshConfigEqual(draft, live),
        path: activeMeshConfigPath(),
        remesh: {
          running: remeshJob.running,
          startedAt: remeshJob.startedAt,
          ok: remeshJob.ok,
          error: remeshJob.error,
          log_tail: remeshJob.log.slice(-4000),
        },
      });
    }

    if (url === "/api/mesh-config" && req.method === "POST") {
      const body = await readBody(req).catch(() => ({}));
      try {
        const saved = writeMeshConfigFile(body.config || body);
        const live = liveMeshConfig();
        return sendJSON(res, 200, {
          ok: true,
          saved,
          live,
          dirty: !meshConfigEqual(saved, live),
          path: activeMeshConfigPath(),
        });
      } catch (e) {
        return sendJSON(res, 500, { error: e.message || String(e) });
      }
    }

    if (url === "/api/remesh" && req.method === "GET") {
      return sendJSON(res, 200, {
        running: remeshJob.running,
        startedAt: remeshJob.startedAt,
        ok: remeshJob.ok,
        error: remeshJob.error,
        log_tail: remeshJob.log.slice(-8000),
      });
    }

    if (url === "/api/remesh" && req.method === "POST") {
      const body = await readBody(req).catch(() => ({}));
      try {
        if (body.config) writeMeshConfigFile(body.config);
        else if (!fs.existsSync(activeMeshConfigPath())) {
          writeMeshConfigFile(liveMeshConfig());
        }
        // Only keep snapshots when explicitly requested (Clean & Restart → false).
        const keepSnapshots = body.keep_snapshots === true;
        startRemesh({ keepSnapshots });
        return sendJSON(res, 202, {
          ok: true,
          started: true,
          keep_snapshots: keepSnapshots,
          path: activeMeshConfigPath(),
          remesh: {
            running: remeshJob.running,
            startedAt: remeshJob.startedAt,
          },
        });
      } catch (e) {
        return sendJSON(res, e.status || 500, { error: e.message || String(e) });
      }
    }

    if (url === "/api/downscale" && req.method === "POST") {
      const body = await readBody(req);
      const issuer = resolveIssuer();
      if (!issuer) return sendJSON(res, 503, { error: "issuer unavailable" });
      if (!body.instance_id) return sendJSON(res, 400, { error: "instance_id required" });
      try {
        const out = await postJson(`${issuer}/v1/downscale`, {
          instance_id: body.instance_id,
          requester_id: body.requester_id || "dashboard",
          reason: body.reason || "dashboard",
        });
        return sendJSON(res, 200, out);
      } catch (e) {
        return sendJSON(res, e.status || 502, { error: e.message, detail: e.body || null });
      }
    }

    // Force-kill a spawned instance without SoftLeave. Local processes are
    // stopped directly (and lose their sticky slot identity); AWS instances go
    // through the issuer, which verifies Role=spawned before terminating EC2.
    if (url === "/api/terminate" && req.method === "POST") {
      const body = await readBody(req);
      const id = String(body.instance_id || "").trim();
      const ip = String(body.ip || "").trim();
      if (!id && !ip) {
        return sendJSON(res, 400, { error: "instance_id or ip required" });
      }
      if (!id || !/^local-\d+$/.test(id)) {
        const issuer = resolveIssuer();
        if (!issuer) return sendJSON(res, 503, { error: "issuer unavailable" });
        try {
          const out = await postJson(`${issuer}/v1/downscale`, {
            instance_id: id || undefined,
            ip: ip || undefined,
            requester_id: body.requester_id || "dashboard",
            reason: body.reason || "dashboard force teardown",
          });
          return sendJSON(res, 200, out);
        } catch (e) {
          return sendJSON(res, e.status || 502, {
            error: e.message,
            detail: e.body || null,
          });
        }
      }
      if (!fs.existsSync(LOCAL_TERMINATE)) {
        return sendJSON(res, 503, { error: "terminate.sh not found" });
      }
      try {
        const out = await runLocalTerminate(id);
        // Drop sticky identity so a later PreferNear spawn is not ignored.
        try {
          fs.unlinkSync(path.join(activeRunDir(), "keys", `${id}.ed25519`));
        } catch (_) {}
        try {
          fs.unlinkSync(path.join(activeRunDir(), "keys", `${id}.cert.json`));
        } catch (_) {}
        return sendJSON(res, 200, { ok: true, instance_id: id, ...out });
      } catch (e) {
        return sendJSON(res, 500, { error: e.message || String(e) });
      }
    }

    if (url === "/api/snapshots" && req.method === "GET") {
      if (!bootIp) return sendJSON(res, 503, { error: "no bootstrap" });
      try {
        const out = await fetchJson(`http://${bootIp}:${monPort}/snapshots`, 8000);
        return sendJSON(res, 200, out);
      } catch (e) {
        return sendJSON(res, e.status || 502, { error: e.message });
      }
    }

    if (url === "/api/snapshots/flush" && req.method === "POST") {
      if (!bootIp) return sendJSON(res, 503, { error: "no bootstrap" });
      const body = await readBody(req).catch(() => ({}));
      const all = !!body.all;
      const targets = all && cache?.nodes
        ? cache.nodes.filter((n) => n.up).map((n) => ({ ip: n.ip, mon: n.mon }))
        : [{ ip: bootIp, mon: monPort }];
      const results = [];
      for (const t of targets) {
        try {
          const out = await postJson(`http://${t.ip}:${t.mon}/checkpoint`, {}, 60000);
          results.push({ ip: t.ip, mon: t.mon, ok: true, ...out });
        } catch (e) {
          results.push({ ip: t.ip, mon: t.mon, ok: false, error: e.message });
        }
      }
      return sendJSON(res, 200, { results });
    }

    if (url === "/api/snapshots/clear" && req.method === "POST") {
      if (!bootIp) return sendJSON(res, 503, { error: "no bootstrap" });
      const body = await readBody(req).catch(() => ({}));
      const prefix = String(body?.prefix || "").trim();
      try {
        const endpoint = `http://${bootIp}:${monPort}/snapshots/clear${
          prefix ? `?prefix=${encodeURIComponent(prefix)}` : ""
        }`;
        const out = await postJson(endpoint, {}, 60000);
        return sendJSON(res, 200, out);
      } catch (e) {
        return sendJSON(res, e.status || 502, { error: e.message, detail: e.body || null });
      }
    }

    if (url === "/api/collections/delete" && req.method === "POST") {
      const body = await readBody(req).catch(() => ({}));
      const name = String(body?.name || "").trim();
      if (!name || /[\/\\\0\r\n]/.test(name)) {
        return sendJSON(res, 400, { error: "valid collection name is required" });
      }
      const targets = (cache?.nodes || [])
        .filter((n) => n.up && n.ip)
        .map((n) => ({ ip: n.ip, mon: n.mon || monPort }));
      if (targets.length === 0 && bootIp) {
        targets.push({ ip: bootIp, mon: monPort });
      }
      if (targets.length === 0) {
        return sendJSON(res, 503, { error: "no live nodes" });
      }

      // Collection ownership is sharded: every live node must forget its local
      // zones. Run concurrently so a large mesh does not serialize S3 cleanup.
      const results = await Promise.all(
        targets.map(async (target) => {
          try {
            const endpoint = `http://${target.ip}:${target.mon}/collections/delete?name=${encodeURIComponent(name)}`;
            const out = await postJson(endpoint, {}, 60000);
            return { ip: target.ip, mon: target.mon, ok: true, ...out };
          } catch (e) {
            return {
              ip: target.ip,
              mon: target.mon,
              ok: false,
              error: e.message,
              detail: e.body || null,
            };
          }
        }),
      );
      if (results.every((result) => result.ok)) {
        networks.removeCollection(activeNetwork.id, name);
        activeNetwork = networks.active();
      }
      return sendJSON(res, 200, {
        collection: name,
        ok: results.every((result) => result.ok),
        results,
      });
    }

    if (url === "/api/dvf/status" && req.method === "GET") {
      return sendJSON(res, 200, {
        running: dvfJob.running,
        paused: !!dvfJob.paused,
        progress: dvfJob.progress,
        result: dvfJob.result,
        error: dvfJob.error,
        startedAt: dvfJob.startedAt,
        dataDir: defaultDvfDataDir(),
        collection: DVF_PURCHASE_COLLECTION,
        legacyGeoCollection: DVF_GEO_COLLECTION,
      });
    }

    if (url === "/api/dvf/pause" && req.method === "POST") {
      if (!dvfJob.running) {
        return sendJSON(res, 409, { error: "no DVF load running" });
      }
      dvfJob.paused = true;
      return sendJSON(res, 200, { ok: true, paused: true, running: true });
    }

    if (url === "/api/dvf/resume" && req.method === "POST") {
      if (!dvfJob.running) {
        return sendJSON(res, 409, { error: "no DVF load running" });
      }
      dvfJob.paused = false;
      return sendJSON(res, 200, { ok: true, paused: false, running: true });
    }

    if (url === "/api/dvf/stop" && req.method === "POST") {
      if (!dvfJob.running) {
        return sendJSON(res, 409, { error: "no DVF load running" });
      }
      dvfJob.abort = true;
      dvfJob.paused = false;
      return sendJSON(res, 200, { ok: true, stopping: true });
    }

    if (url === "/api/dvf/load" && req.method === "POST") {
      if (dvfJob.running) {
        return sendJSON(res, 409, {
          error: "DVF load already running",
          progress: dvfJob.progress,
          paused: !!dvfJob.paused,
        });
      }
      if (!bootIp) return sendJSON(res, 503, { error: "no bootstrap" });
      const body = await readBody(req).catch(() => ({}));
      const full = body.full === true || body.limit === 0 || body.limit === "full";
      const limit = full
        ? null
        : Math.max(
            1,
            Math.min(2_000_000, parseInt(body.limit || 5000, 10) || 5000),
          );
      const collectionId = body.collection || DVF_PURCHASE_COLLECTION;
      const year = body.year ? String(body.year) : "2020";
      const route = body.route === "rr" ? "rr" : "xor";
      const host = body.host || bootIp;
      const ports =
        Array.isArray(body.ports) && body.ports.length
          ? body.ports.map((p) => parseInt(p, 10)).filter((n) => !Number.isNaN(n))
          : [
              ...new Set(
                (cache?.nodes || [])
                  .filter((n) => n.up && n.p2p)
                  .map((n) => n.p2p)
                  .concat([p2pPort]),
              ),
            ];
      const issuer = resolveIssuer();
      if (!issuer) return sendJSON(res, 503, { error: "issuer unavailable" });

      let bearer = body.bearer || "";
      if (!bearer) {
        try {
          const tok = await postJson(`${issuer}/v1/issue/token`, {
            client_id: `mesh-dash-dvf-${Date.now()}`,
            scopes: ["read", "write"],
          });
          bearer = tok.token || tok.access_token || tok.bearer || "";
        } catch (e) {
          return sendJSON(res, e.status || 502, {
            error: e.message,
            detail: e.body || null,
          });
        }
      }
      if (!bearer) return sendJSON(res, 502, { error: "no bearer from issuer" });

      dvfJob.running = true;
      dvfJob.abort = false;
      dvfJob.paused = false;
      dvfJob.progress = {
        phase: "queued",
        limit: limit ?? "full",
        collectionId,
        year,
        route,
      };
      dvfJob.result = null;
      dvfJob.error = null;
      dvfJob.startedAt = Date.now();

      loadDvfPurchases({
        host,
        ports: ports.length ? ports : [p2pPort],
        bearer,
        collectionId,
        year,
        route,
        limit: limit ?? undefined,
        shouldAbort: () => dvfJob.abort,
        shouldPause: () => dvfJob.paused,
        onProgress: (info) => {
          dvfJob.progress = info;
        },
      })
        .then((result) => {
          dvfJob.result = result;
          dvfJob.running = false;
          dvfJob.paused = false;
        })
        .catch((e) => {
          dvfJob.error = String(e.message || e);
          dvfJob.running = false;
          dvfJob.paused = false;
        });

      return sendJSON(res, 202, {
        ok: true,
        message: "DVF load started",
        limit: limit ?? "full",
        year,
        route,
        collectionId,
        host,
        ports,
      });
    }

    // Static files (Vite dist in production, public/ fallback)
    if (req.method === "GET" || req.method === "HEAD") {
      const root = staticRoot();
      let rel = url === "/" ? "/index.html" : url;
      let filePath = path.normalize(path.join(root, rel));
      if (!filePath.startsWith(root)) {
        res.writeHead(403);
        res.end("forbidden");
        return;
      }
      // SPA fallback
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = path.join(root, "index.html");
      }
      if (!fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end(
          "UI not built — run: pnpm install && pnpm build  (or pnpm dev for Vite)"
        );
        return;
      }
      const data = fs.readFileSync(filePath);
      res.writeHead(200, { "Content-Type": contentType(filePath) });
      res.end(req.method === "HEAD" ? undefined : data);
      return;
    }

    sendJSON(res, 404, { error: "not found" });
  } catch (e) {
    sendJSON(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Indexus mesh dash → http://127.0.0.1:${PORT}/`);
  console.log(`  BOOT_IP=${bootIp || "(probe local)"} MON_PORT=${monPort}`);
  console.log(`  ISSUER_URL=${resolveIssuer() || "(from BOOT_IP:22000)"}`);
  console.log(`  static: ${staticRoot()}`);
  console.log(
    `  APIs: /api/mesh · /api/token · /api/spawn · /api/downscale · /api/terminate · /api/mesh-config · /api/remesh · /api/snapshots/* · /api/collections/delete · /api/dvf/{load,status,pause,resume,stop}`,
  );
  console.log(`  DVF_DATA_DIR=${defaultDvfDataDir()}`);
  pollLoop();
});
