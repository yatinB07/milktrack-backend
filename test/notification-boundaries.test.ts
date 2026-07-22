import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

void test('notification application and HTTP layers depend only on application contracts', () => {
  for (const path of [
    '../src/notifications/application/notification.service.ts',
    '../src/notifications/http/notification.dto.ts',
    '../src/notifications/http/customer-notification.controller.ts',
  ]) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /notifications\/infrastructure|\.\.\/infrastructure\//u, path);
  }
});
