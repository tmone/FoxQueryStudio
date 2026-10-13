/** A server as SSMS writes it: `host`, `host\\instance`, `host,port` or `host\\instance,port`. */
export interface ServerName {
  host: string;
  instance?: string;
  port?: number;
}

export function parseServerName(text: string): ServerName {
  const [address, portText] = text.trim().split(',', 2);
  const [host, instance] = address.split('\\', 2);
  const port = portText?.trim() ? Number(portText) : undefined;
  return { host: host.trim(), instance: instance?.trim() || undefined, port: Number.isInteger(port) && port! > 0 ? port : undefined };
}

export function formatServerName({ host, instance, port }: ServerName): string {
  return `${host}${instance ? `\\${instance}` : ''}${port ? `,${port}` : ''}`;
}
