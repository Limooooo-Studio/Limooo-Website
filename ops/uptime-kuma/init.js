#!/usr/bin/env node
/**
 * Uptime Kuma 首次初始化脚本（在容器内运行）
 *
 * 职责：
 * 1. 如果数据库还未选择，就用 SQLite 完成数据库初始化；
 * 2. 如果没有用户，创建管理账号（凭据由宿主 shell 传入环境变量）；
 * 3. 登录并补齐默认监控项；
 * 4. 输出 KUMA_PUSH_URL，供宿主写回 secrets/uptime-kuma.env。
 *
 * 本脚本不会回显用户名/密码/token 之外的敏感信息。
 */

const crypto = require("crypto");
const axios = require("axios");
const { io } = require("socket.io-client");

const BASE = `http://127.0.0.1:3001`;
const USERNAME = process.env.KUMA_ADMIN_USERNAME;
const PASSWORD = process.env.KUMA_ADMIN_PASSWORD;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function requireEnv(name) {
  if (!process.env[name]) {
    throw new Error(`Missing environment variable: ${name}`);
  }
}

async function request(method, path, body) {
  const response = await axios.request({
    method,
    url: `${BASE}${path}`,
    data: body,
    timeout: 10000,
  });
  return response.data;
}

async function waitForMainServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const info = await request("GET", "/setup-database-info");
      if (info && info.needSetup === false) {
        return;
      }
    } catch (error) {
      // setup server 重启期间可能短暂不可达，继续等待
    }
    await sleep(2000);
  }
  throw new Error("Uptime Kuma main server did not become ready");
}

async function ensureDatabaseConfig() {
  const info = await request("GET", "/setup-database-info");
  if (info.needSetup === false) {
    return;
  }
  await request("POST", "/setup-database", {
    dbConfig: {
      type: "sqlite",
    },
  });
  await waitForMainServer();
}

function connect() {
  return new Promise((resolve, reject) => {
    const socket = io(BASE, {
      forceNew: true,
      transports: ["websocket"],
      reconnection: false,
      timeout: 10000,
    });
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error("Socket.io connection timeout"));
    }, 15000);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("connect_error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function emit(socket, event, ...args) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Socket event timeout: ${event}`));
    }, 15000);
    socket.emit(event, ...args, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

function randomToken() {
  return crypto.randomBytes(24).toString("base64url");
}

function monitorBase(extra) {
  const browserUA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Safari/605.1.15";
  return {
    parent: null,
    interval: 60,
    retryInterval: 60,
    resendInterval: 0,
    timeout: 48,
    maxretries: 0,
    retryOnlyOnStatusCodeFailure: false,
    notificationIDList: {},
    headers: JSON.stringify({ "User-Agent": browserUA }),
    ignoreTls: false,
    upsideDown: false,
    expiryNotification: false,
    domainExpiryNotification: true,
    maxredirects: 10,
    accepted_statuscodes: ["200-299"],
    saveResponse: false,
    saveErrorResponse: true,
    responseMaxLength: 1024,
    dns_resolve_type: "A",
    dns_resolve_server: "",
    docker_container: "",
    docker_host: null,
    proxyId: null,
    basic_auth_user: "",
    basic_auth_pass: "",
    bearer_token: "",
    mqttUsername: "",
    mqttPassword: "",
    mqttTopic: "",
    mqttWebsocketPath: "",
    mqttSuccessMessage: "",
    mqttCheckType: "keyword",
    authMethod: null,
    oauth_auth_method: "client_secret_basic",
    httpBodyEncoding: "json",
    kafkaProducerBrokers: [],
    kafkaProducerSaslOptions: { mechanism: "None" },
    cacheBust: false,
    kafkaProducerSsl: false,
    kafkaProducerAllowAutoTopicCreation: false,
    gamedigGivenPortOnly: true,
    gamedigToken: "",
    remote_browser: null,
    screenshot_delay: 0,
    rabbitmqNodes: [],
    rabbitmqUsername: "",
    rabbitmqPassword: "",
    conditions: [],
    system_service_name: "",
    ntpStratumThreshold: 5,
    ntpTimeOffsetThreshold: 1000,
    ntpRootDispersionThreshold: 500,
    ...extra,
  };
}

function defaultMonitors(pushToken) {
  return [
    monitorBase({
      type: "http",
      name: "Limooo 主站",
      url: "https://limooo.cn/_health",
      method: "GET",
    }),
    monitorBase({
      type: "http",
      name: "Limooo Services",
      url: "https://services.limooo.cn/_health",
      method: "GET",
    }),
    monitorBase({
      type: "http",
      name: "Limooo Contact",
      url: "https://contact.limooo.cn/_health",
      method: "GET",
    }),
    monitorBase({
      type: "http",
      name: "Authentik SSO",
      url: "https://admin.limooo.cn/_health",
      method: "GET",
    }),
    monitorBase({
      type: "http",
      name: "Uptime Kuma Admin",
      url: "https://admin.limooo.cn/_health",
      method: "GET",
    }),
    monitorBase({
      type: "push",
      name: "Limooo D1 健康检查",
      url: "",
      method: "GET",
      interval: 3600,
      retryInterval: 3600,
      timeout: 2880,
      pushToken,
    }),
  ];
}

async function getMonitorList(socket) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("getMonitorList timeout")), 15000);
    socket.once("monitorList", (list) => {
      clearTimeout(timer);
      resolve(Object.values(list || {}));
    });
    socket.emit("getMonitorList", (response) => {
      if (!response || !response.ok) {
        clearTimeout(timer);
        reject(new Error(`getMonitorList failed: ${response ? response.msg : "unknown"}`));
      }
    });
  });
}

async function main() {
  requireEnv("KUMA_ADMIN_USERNAME");
  requireEnv("KUMA_ADMIN_PASSWORD");

  await ensureDatabaseConfig();

  const socket = await connect();
  try {
    // 服务端 connection handler 在发送 info 后才注册 needSetup 等事件，
    // 客户端 connect 可能先于注册完成，稍等一拍避免竞态。
    await sleep(500);
    const needSetup = await emit(socket, "needSetup");
    if (needSetup) {
      const setupResult = await emit(socket, "setup", USERNAME, PASSWORD);
      if (!setupResult || !setupResult.ok) {
        throw new Error(`Setup failed: ${setupResult ? setupResult.msg : "unknown"}`);
      }
    }

    const loginResult = await emit(socket, "login", { username: USERNAME, password: PASSWORD });
    if (!loginResult || !loginResult.ok || !loginResult.token) {
      throw new Error(`Login failed: ${loginResult ? loginResult.msg : "unknown"}`);
    }

    const existing = await getMonitorList(socket);
    const existingByName = new Map(existing.map((monitor) => [monitor.name, monitor]));
    const existingPush = existing.find(
      (monitor) => monitor.name === "Limooo D1 健康检查" && monitor.type === "push"
    );
    const pushToken = existingPush && existingPush.pushToken ? existingPush.pushToken : randomToken();
    const monitors = defaultMonitors(pushToken);

    let created = 0;
    let updated = 0;
    for (const monitor of monitors) {
      const current = existingByName.get(monitor.name);
      if (current) {
        // HTTP 监控统一补浏览器 UA，避免 Cloudflare/Nginx 的非浏览器拦截造成误报。
        // 保留当前通知关系与其余配置，不重复创建。
        if (current.type === "http") {
          const result = await emit(socket, "editMonitor", {
            ...current,
            ...monitor,
            id: current.id,
            notificationIDList: current.notificationIDList || {},
          });
          if (!result || !result.ok) {
            throw new Error(`Update monitor failed (${monitor.name}): ${result ? result.msg : "unknown"}`);
          }
          updated += 1;
        }
        continue;
      }
      const result = await emit(socket, "add", monitor);
      if (!result || !result.ok) {
        throw new Error(`Add monitor failed (${monitor.name}): ${result ? result.msg : "unknown"}`);
      }
      created += 1;
    }

    // 输出 push URL，宿主脚本会写回 secrets/uptime-kuma.env
    const pushUrl = `https://admin.limooo.cn/api/push/${pushToken}?status=up&msg=ok`;
    console.log(`KUMA_PUSH_URL=${pushUrl}`);
    console.log(`initialized=true createdMonitors=${created} updatedMonitors=${updated}`);
  } finally {
    socket.disconnect();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
