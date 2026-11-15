import { defineRailway, image, postgres, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const Postgres = postgres("Postgres", { region: "iad" });
  Postgres.networking = { privateNetworkEndpoint: "postgres" };
  const postgres17Volume = volume("postgres17-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "iad", sizeMB: 500 });
  const postgresVolume = volume("postgres-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "iad", sizeMB: 500 });
  const cron = service("cron", {
    build: { buildCommand: "echo cron: no build required", buildEnvironment: "V3", builder: "RAILPACK" },
    start: "node scripts/run-cron.mjs",
    replicas: { "iad": 1 },
    deploy: { cronSchedule: "*/15 * * * *", restartPolicyType: "NEVER" },
  });
  const web = service("web", {
    build: { buildEnvironment: "V3", builder: "RAILPACK" },
    replicas: { "iad": 1 },
    domains: ["umantai.com"],
  });
  const Postgres17 = service("Postgres17", {
    source: image("postgres:17"),
    build: { buildEnvironment: "V3", builder: "RAILPACK" },
    replicas: { "iad": 1 },
    networking: { privateNetworkEndpoint: "postgres17" },
    volumeMounts: { "/var/lib/postgresql/data": postgres17Volume },
  });

  return project("UMANTAI", {
    variables: { managed: false },
    resources: [cron, Postgres, web, Postgres17, postgres17Volume, postgresVolume],
  });
});
