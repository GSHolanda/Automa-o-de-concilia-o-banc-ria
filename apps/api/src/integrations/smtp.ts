import type { SmtpConfig } from '@concilia/core';
import nodemailer from 'nodemailer';
import { scrubSecret } from '../security/secrets';
import { resolveSafeAddress, SafeFetchError } from './http';

const TIMEOUT_MS = 10_000;

export class SmtpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmtpError';
  }
}

/** Transporte SMTP para o endereço já conferido (mesma proteção do safeFetch); TLS valida o nome original. */
async function transportFor(config: SmtpConfig, secret: string | null, allowPrivate: boolean) {
  const target = await resolveSafeAddress(config.host, allowPrivate);
  return nodemailer.createTransport({
    host: target.address,
    port: config.port,
    secure: config.secure,
    ...(config.user ? { auth: { user: config.user, pass: secret ?? '' } } : {}),
    tls: { servername: config.host },
    connectionTimeout: TIMEOUT_MS,
    greetingTimeout: TIMEOUT_MS,
    socketTimeout: TIMEOUT_MS,
  });
}

function smtpMessage(error: unknown, secret: string | null): string {
  if (error instanceof SafeFetchError) return error.message;
  const code = (error as { code?: string; responseCode?: number })?.code;
  const responseCode = (error as { responseCode?: number })?.responseCode;
  const detail = [code, responseCode].filter(Boolean).join(' ');
  return scrubSecret(`Falha no servidor SMTP${detail ? ` (${detail})` : ''}.`, secret);
}

/** Verificação real: conecta, negocia e autentica no servidor SMTP. */
export async function verifySmtp(config: SmtpConfig, secret: string | null, allowPrivate: boolean): Promise<void> {
  try {
    const transport = await transportFor(config, secret, allowPrivate);
    try {
      await transport.verify();
    } finally {
      transport.close();
    }
  } catch (error) {
    throw new SmtpError(smtpMessage(error, secret));
  }
}

export async function sendSmtp(
  config: SmtpConfig,
  secret: string | null,
  allowPrivate: boolean,
  message: { to: string[]; subject: string; text: string },
): Promise<void> {
  try {
    const transport = await transportFor(config, secret, allowPrivate);
    try {
      await transport.sendMail({ from: config.from, to: message.to, subject: message.subject, text: message.text });
    } finally {
      transport.close();
    }
  } catch (error) {
    throw new SmtpError(smtpMessage(error, secret));
  }
}
