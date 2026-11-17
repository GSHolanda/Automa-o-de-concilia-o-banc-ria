import pg from 'pg';

// Datas civis (tipo date) chegam como texto AAAA-MM-DD, sem conversão de fuso horário.
pg.types.setTypeParser(pg.types.builtins.DATE, (value: string) => value);

export function createPool(connectionString: string, max: number): pg.Pool {
  return new pg.Pool({ connectionString, max, application_name: 'concilia' });
}
