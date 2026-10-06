import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { FoxTable } from '../dbf/database';
import { createTableSql, insertSql } from '../dbf/to-sql';
import type { DbApi, ExecuteResult } from '../shared/types';
import { SCHEMA_QUERY, schemaFromRows } from './db';

/**
 * The engine behind a local FoxPro database: SQL Server LocalDB, started and fed by the app
 * itself, so a folder of .dbf files can be queried in FoxPro and in T-SQL with no server to
 * connect to. LocalDB only speaks named pipes, which the TCP driver cannot use; the bridge is
 * a PowerShell process that hosts .NET's SqlClient and answers one JSON request per line.
 */
const BRIDGE_SOURCE = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies 'System.Data', 'System.Web.Extensions', 'System.Xml' -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Data;
using System.Data.SqlClient;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

public static class FqsBridge
{
    static readonly Dictionary<string, SqlConnection> Sessions = new Dictionary<string, SqlConnection>();

    public static void Run()
    {
        var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        var output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        output.AutoFlush = true;
        var json = new JavaScriptSerializer();
        json.MaxJsonLength = int.MaxValue;
        output.WriteLine("{\"ready\":true}");
        string line;
        while ((line = input.ReadLine()) != null)
        {
            if (line.Length == 0) continue;
            var request = json.Deserialize<Dictionary<string, object>>(line);
            var response = new Dictionary<string, object>();
            response["id"] = request["id"];
            try { Handle(request, response); }
            catch (Exception e) { response["error"] = e.Message; }
            output.WriteLine(json.Serialize(response));
        }
    }

    static void Close(string session)
    {
        SqlConnection connection;
        if (!Sessions.TryGetValue(session, out connection)) return;
        Sessions.Remove(session);
        try { connection.Dispose(); } catch (Exception) { }
    }

    static void Handle(Dictionary<string, object> request, Dictionary<string, object> response)
    {
        var session = (string)request["session"];
        if ((string)request["op"] == "close") { Close(session); return; }

        SqlConnection connection;
        if (!Sessions.TryGetValue(session, out connection))
        {
            var builder = new SqlConnectionStringBuilder();
            builder.DataSource = "(localdb)\\MSSQLLocalDB";
            builder.InitialCatalog = (string)request["database"];
            builder.IntegratedSecurity = true;
            builder.ApplicationName = "FoxQueryStudio";
            // Each session owns its connection, so its #temp tables live as long as the tab.
            builder.Pooling = false;
            builder.ConnectTimeout = 60;
            connection = new SqlConnection(builder.ConnectionString);
            connection.Open();
            Sessions[session] = connection;
        }

        var maxRows = Convert.ToInt32(request["maxRows"]);
        var messages = new List<string>();
        var sets = new List<object>();
        var truncated = false;
        string error = null;
        SqlInfoMessageEventHandler onInfo = delegate(object sender, SqlInfoMessageEventArgs e) { messages.Add(e.Message); };
        connection.InfoMessage += onInfo;
        var watch = Stopwatch.StartNew();
        try
        {
            using (var command = new SqlCommand((string)request["sql"], connection))
            {
                command.CommandTimeout = 120;
                using (var reader = command.ExecuteReader())
                {
                    do
                    {
                        if (reader.FieldCount == 0) continue;
                        var columns = new List<string>();
                        for (var i = 0; i < reader.FieldCount; i++) columns.Add(reader.GetName(i));
                        var rows = new List<object[]>();
                        while (reader.Read())
                        {
                            if (rows.Count >= maxRows) { truncated = true; break; }
                            var row = new object[reader.FieldCount];
                            for (var i = 0; i < row.Length; i++) row[i] = Cell(reader.GetValue(i));
                            rows.Add(row);
                        }
                        var set = new Dictionary<string, object>();
                        set["columns"] = columns;
                        set["rows"] = rows;
                        sets.Add(set);
                        if (truncated) { command.Cancel(); break; }
                    } while (reader.NextResult());
                }
            }
        }
        catch (SqlException e)
        {
            // Cancelling at the row limit surfaces as an error; it is not a failure.
            if (!truncated) error = e.Message;
        }
        finally { connection.InfoMessage -= onInfo; }

        if (connection.State != ConnectionState.Open)
        {
            Close(session);
            response["sessionReset"] = true;
        }
        response["resultSets"] = sets;
        response["messages"] = messages;
        response["truncated"] = truncated;
        response["elapsedMs"] = watch.ElapsedMilliseconds;
        if (error != null) response["error"] = error;
    }

    // Display-ready values, formatted the way the TCP driver's results are.
    static object Cell(object value)
    {
        if (value == null || value is DBNull) return null;
        if (value is DateTime)
        {
            var date = (DateTime)value;
            if (date.TimeOfDay == TimeSpan.Zero) return date.ToString("yyyy-MM-dd");
            return date.ToString(date.Millisecond == 0 ? "yyyy-MM-dd HH:mm:ss" : "yyyy-MM-dd HH:mm:ss.fff");
        }
        var bytes = value as byte[];
        if (bytes != null) return "0x" + BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant();
        if (value is string || value is bool || value is int || value is long || value is short || value is byte || value is decimal || value is double || value is float) return value;
        return Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture);
    }
}
'@
[FqsBridge]::Run()
`;

const MASTER = 'master';
const ADMIN_SESSION = '__admin';
const IMPORT_SESSION = '__import';
const SCHEMA_SESSION = '__schema';
const SCHEMA_MAX_ROWS = 1_000_000;
const STARTUP_TIMEOUT_MS = 60_000;
/** Statements sent per request while importing; each INSERT already carries many rows. */
const STATEMENTS_PER_REQUEST = 20;

type BridgeResponse = Partial<ExecuteResult> & { id: number; error?: string };

/** A FoxPro database folder turned into a LocalDB database name, e.g. FoxQuery_northwind. */
export const localDatabaseName = (folder: string) => `FoxQuery_${(folder.split(/[\\/]/).filter(Boolean).pop() ?? 'db').replace(/\W/g, '_').slice(0, 60)}`;

export interface LocalEngine extends DbApi {
  /** Replaces the named database with the given tables and makes it the one queries run in. */
  openDatabase(name: string, tables: FoxTable[]): Promise<void>;
  /** Stops the engine process; it starts again on the next use. */
  shutdown(): void;
}

export function createLocalEngine(scriptDir = tmpdir()): LocalEngine {
  let child: ChildProcessWithoutNullStreams | undefined;
  let ready: Promise<void> | undefined;
  let database: string | undefined;
  let nextId = 1;
  const pending = new Map<number, { resolve(response: BridgeResponse): void; reject(error: Error): void }>();
  const sessions = new Set<string>();

  function start(): Promise<void> {
    if (ready) return ready;
    const script = join(scriptDir, `fqs-local-engine-${process.pid}.ps1`);
    // The BOM makes Windows PowerShell read the file as UTF-8.
    writeFileSync(script, `﻿${BRIDGE_SOURCE}`, 'utf8');
    const started = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true });
    child = started;
    let stderr = '';
    started.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));

    ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Engine cục bộ không khởi động được (quá thời gian chờ).')), STARTUP_TIMEOUT_MS);
      createInterface({ input: started.stdout }).on('line', (line) => {
        const message = JSON.parse(line) as BridgeResponse & { ready?: boolean };
        if (message.ready) {
          clearTimeout(timer);
          resolve();
          return;
        }
        pending.get(message.id)?.resolve(message);
        pending.delete(message.id);
      });
      const stopped = (reason: string) => {
        clearTimeout(timer);
        const error = new Error(`Engine cục bộ đã dừng: ${stderr.trim() || reason}`);
        reject(error);
        for (const request of pending.values()) request.reject(error);
        pending.clear();
        sessions.clear();
        if (child === started) {
          child = undefined;
          ready = undefined;
        }
      };
      started.on('error', (e) => stopped(e.message));
      started.on('exit', (code) => stopped(`mã thoát ${code}`));
    });
    return ready;
  }

  async function send(request: Record<string, unknown>): Promise<BridgeResponse> {
    await start();
    const id = nextId++;
    return new Promise<BridgeResponse>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child!.stdin.write(`${JSON.stringify({ ...request, id })}\n`);
    });
  }

  async function executeIn(target: string, sessionId: string, sql: string, maxRows: number): Promise<ExecuteResult> {
    sessions.add(sessionId);
    let response: BridgeResponse;
    try {
      response = await send({ op: 'execute', session: sessionId, database: target, sql, maxRows });
    } catch (e) {
      return { resultSets: [], messages: [], error: (e as Error).message, truncated: false, sessionReset: true, elapsedMs: 0 };
    }
    return {
      resultSets: response.resultSets ?? [],
      messages: response.messages ?? [],
      error: response.error,
      truncated: response.truncated ?? false,
      sessionReset: response.sessionReset,
      elapsedMs: response.elapsedMs ?? 0,
    };
  }

  /** Runs a statement that must succeed. */
  async function must(target: string, sessionId: string, sql: string, what: string): Promise<void> {
    const result = await executeIn(target, sessionId, sql, 0);
    if (result.error) throw new Error(`${what}: ${result.error}`);
  }

  async function closeSession(sessionId: string): Promise<void> {
    if (!sessions.delete(sessionId) || !child) return;
    await send({ op: 'close', session: sessionId }).catch(() => undefined);
  }

  async function disconnect(): Promise<void> {
    database = undefined;
    await Promise.all([...sessions].map(closeSession));
  }

  function requireDatabase(): string {
    if (!database) throw new Error('Chưa mở CSDL FoxPro cục bộ.');
    return database;
  }

  return {
    async connect() {
      throw new Error('Engine cục bộ chỉ mở thư mục FoxPro.');
    },

    disconnect,
    closeSession,

    async openDatabase(name, tables) {
      await disconnect();
      try {
        await must(
          MASTER,
          ADMIN_SESSION,
          `IF DB_ID('${name}') IS NOT NULL BEGIN ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${name}]; END;\nCREATE DATABASE [${name}]`,
          'Không tạo được CSDL cục bộ (máy cần có SQL Server Express LocalDB)',
        );
        for (const table of tables) {
          const statements = [createTableSql(table), ...insertSql(table)];
          for (let i = 0; i < statements.length; i += STATEMENTS_PER_REQUEST) {
            await must(name, IMPORT_SESSION, statements.slice(i, i + STATEMENTS_PER_REQUEST).join(';\n'), `Không nạp được bảng ${table.name}`);
          }
        }
      } finally {
        await closeSession(ADMIN_SESSION);
        await closeSession(IMPORT_SESSION);
      }
      database = name;
    },

    async loadSchema() {
      const result = await executeIn(requireDatabase(), SCHEMA_SESSION, SCHEMA_QUERY, SCHEMA_MAX_ROWS);
      await closeSession(SCHEMA_SESSION);
      if (result.error) throw new Error(result.error);
      const [set] = result.resultSets;
      return schemaFromRows(set.rows.map((row) => Object.fromEntries(set.columns.map((name, i) => [name, row[i]]))));
    },

    execute: (sessionId, sql, maxRows) => executeIn(requireDatabase(), sessionId, sql, maxRows),

    shutdown() {
      child?.kill();
    },
  };
}
