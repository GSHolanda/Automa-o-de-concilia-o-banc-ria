import { describe, expect, it } from 'vitest';
import { passwordProblem } from '../../src/security/password';

const policy = { minLength: 8 };

describe('passwordProblem: senhas comuns (achado 13)', () => {
  it('recusa palavra comum seguida ou precedida só de números e símbolos', () => {
    for (const password of ['Senha12345', 'senha@2024', 'Password123!', 'Admin@1234', 'Qwerty123', '12345678', '2024@Brasil', 'Mudar@123']) {
      expect(passwordProblem(password, policy), password).toMatch(/comum/);
    }
  });

  it('aceita frases e combinações que não se resumem a uma palavra comum', () => {
    for (const password of ['Senha-de-teste-123', 'Nova-senha-forte-456', 'Cavalo-Bateria-Grampo', 'Demonstracao-Segura-2024']) {
      expect(passwordProblem(password, policy), password).toBeNull();
    }
  });
});
