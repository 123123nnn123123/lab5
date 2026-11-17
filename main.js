import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { program } from 'commander';
import superagent from 'superagent';

// ---------------------------------------------------------------
// 1. Параметри командного рядка
// ---------------------------------------------------------------
// -h за замовчуванням зайнято під --help, тому вимикаємо стандартну довідку.
// requiredOption: за відсутності опції commander виводить помилку
// й завершує процес з ненульовим кодом.
program
  .helpOption(false)
  .requiredOption('-h, --host <address>', 'адреса, на якій працює сервер')
  .requiredOption('-p, --port <number>', 'порт сервера')
  .requiredOption('-c, --cache <path>', 'шлях до теки з кешем картинок');

program.parse();
const { host, port, cache } = program.opts();

const portNumber = Number(port);
if (!Number.isInteger(portNumber) || portNumber < 0 || portNumber > 65535) {
  console.error(`Помилка: некоректний порт "${port}"`);
  process.exit(1);
}

// Тека кешу створюється до початку приймання запитів.
await fs.mkdir(cache, { recursive: true });

// ---------------------------------------------------------------
// 2. Допоміжні функції
// ---------------------------------------------------------------

// Дозволений шлях: "/" + рівно три цифри (код 100-599).
// В ім'я файлу потрапляють лише цифри, тому path traversal неможливий.
function parseCode(url) {
  const match = /^\/(\d{3})$/.exec(url.split('?')[0]);
  if (!match) return null;
  const code = Number(match[1]);
  return code >= 100 && code <= 599 ? code : null;
}

function filePath(code) {
  return path.join(cache, `${code}.jpg`);
}

// Відповідь із текстовим повідомленням.
function send(res, status, text, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    ...headers,
  });
  res.end(text);
}

// Тіло запиту — потік чанків. for await читає його без колбеків.
// Збираємо саме Buffer, а не рядок, щоб не пошкодити двійкові дані.
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Запит до http.cat. superagent відхиляє проміс при мережевій помилці
// та при статусах 4xx/5xx. parse.image повертає тіло як Buffer.
async function fetchFromCat(code) {
  const response = await superagent
    .get(`https://http.cat/${code}`)
    .buffer(true)
    .parse(superagent.parse.image);
  return response.body;
}

// Атомарний запис: спочатку у тимчасовий файл, потім rename.
// Так клієнт ніколи не прочитає наполовину записаний файл.
async function saveAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

// ---------------------------------------------------------------
// 3. Обробники методів
// ---------------------------------------------------------------
async function handleGet(res, code) {
  const file = filePath(code);
  let image;
  let source;
  try {
    image = await fs.readFile(file);
    source = 'HIT'; // влучання в кеш
  } catch (err) {
    if (err.code !== 'ENOENT') throw err; // інша помилка ФС -> 500

    // Промах кешу: йдемо на http.cat
    try {
      image = await fetchFromCat(code);
    } catch {
      return send(res, 404, 'Картинку не знайдено');
    }
    await saveAtomic(file, image);
    source = 'MISS';
  }

  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Content-Length': image.length,
    'X-Cache': source,
  });
  res.end(image);
}
async function handlePut(req, res, code) {
  const body = await readBody(req);
  if (body.length === 0) {
    return send(res, 400, 'Порожнє тіло запиту');
  }
  await saveAtomic(filePath(code), body);
  send(res, 201, 'Картинку збережено');
}

async function handleDelete(res, code) {
  try {
    await fs.unlink(filePath(code));
  } catch (err) {
    if (err.code === 'ENOENT') {
      return send(res, 404, 'У кеші немає такої картинки');
    }
    throw err;
  }
  send(res, 200, 'Картинку видалено');
}
// ---------------------------------------------------------------
// 4. Сервер
// ---------------------------------------------------------------
// Єдиний колбек у програмі — async-обробник запиту.
const server = http.createServer(async (req, res) => {
  try {
    const code = parseCode(req.url);
    if (code === null) {
      return send(res, 404, 'Невірний шлях: очікується /<код стану>, наприклад /404');
    }

    switch (req.method) {
      case 'GET':
        return await handleGet(res, code);
      case 'PUT':
        return await handlePut(req, res, code);
      case 'DELETE':
        return await handleDelete(res, code);
      default:
        return send(res, 405, 'Метод не підтримується', {
          Allow: 'GET, PUT, DELETE',
        });
    }
  } catch (err) {
    console.error('Помилка обробки запиту:', err);
    if (!res.headersSent) {
      send(res, 500, 'Внутрішня помилка сервера');
    } else {
      res.end();
    }
  }
});
// once() з node:events повертає проміс: без колбеків.
// Якщо listen впаде (наприклад, порт зайнятий), once відхилить проміс.
server.listen(portNumber, host);
await once(server, 'listening');
console.log(`Проксі-сервер працює на http://${host}:${portNumber}, кеш: ${path.resolve(cache)}`);