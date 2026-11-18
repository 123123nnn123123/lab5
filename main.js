// Підтримує методи: GET (отримати), PUT (записати), DELETE (видалити).

import http from 'node:http';               // вбудований модуль для створення HTTP-сервера
import { once } from 'node:events';         // дає змогу чекати подію через проміс (без колбеків)
import fs from 'node:fs/promises';          // файлові операції, що повертають проміси
import path from 'node:path';               // робота зі шляхами до файлів
import { program } from 'commander';        // розбір аргументів командного рядка
import superagent from 'superagent';        // HTTP-клієнт для запитів до http.cat

program
  .helpOption(false)
  .requiredOption('-h, --host <address>', 'адреса, на якій працює сервер')
  .requiredOption('-p, --port <number>', 'порт сервера')
  .requiredOption('-c, --cache <path>', 'шлях до теки з кешем картинок');

program.parse();
const { host, port, cache } = program.opts();

// Перевіряємо, що порт є цілим числом 
const portNumber = Number(port);
if (!Number.isInteger(portNumber) || portNumber < 0 || portNumber > 65535) {
  console.error(`Помилка: некоректний порт "${port}"`);
  process.exit(1);
}

// Створюємо теку кешу до початку приймання запитів.
// recursive: true не дає помилки, якщо тека вже існує.
await fs.mkdir(cache, { recursive: true });

// ---------------------------------------------------------------
// 2. Допоміжні функції
// ---------------------------------------------------------------

/**
 * Дістає код стану HTTP зі шляху запиту.
 * Дозволений формат: "/" і рівно три цифри (наприклад, "/404").
 * Оскільки в код потрапляють лише цифри, у назву файлу не можна
 * підставити "../", тобто вийти за межі теки кешу (path traversal).
 * @param {string} url - шлях із запиту, наприклад "/404" або "/404?x=1"
 * @returns {number|null} код 100-599 або null, якщо шлях некоректний
 */
function parseCode(url) {
  const match = /^\/(\d{3})$/.exec(url.split('?')[0]);
  if (!match) return null;
  const code = Number(match[1]);
  return code >= 100 && code <= 599 ? code : null;
}

/**
 * Формує шлях до файлу з картинкою в теці кешу.
 * Для кожного коду стану використовується окремий файл.
 * @param {number} code - код стану HTTP
 * @returns {string} шлях до файлу, наприклад "cache/404.jpg"
 */
function filePath(code) {
  return path.join(cache, `${code}.jpg`);
}

/**
 * Надсилає клієнтові відповідь із текстовим повідомленням.
 * Використовується для помилок і підтверджень (201, 404, 405 тощо).
 * @param {http.ServerResponse} res - об'єкт відповіді
 * @param {number} status - код стану HTTP
 * @param {string} text - текст повідомлення
 * @param {object} [headers] - додаткові заголовки (наприклад, Allow)
 */
function send(res, status, text, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    ...headers,
  });
  res.end(text);
}

/**
 * Зчитує тіло запиту цілком.
 * Тіло надходить потоком частинами (чанками), тому ми збираємо їх
 * циклом for await
 * Чанки складаємо саме в Buffer, а не в рядок, щоб не пошкодити
 * двійкові дані картинки.
 * @param {http.IncomingMessage} req - об'єкт запиту
 * @returns {Promise<Buffer>} усе тіло запиту
 */
async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Завантажує картинку для заданого коду з https://http.cat.
 * Проміс superagent відхиляється і при мережевій помилці, і при
 * відповідях 4xx/5xx, тому помилку ловить викликач через try/catch.
 * parse.image повертає тіло відповіді як Buffer без змін.
 * @param {number} code - код стану HTTP
 * @returns {Promise<Buffer>} двійкові дані картинки
 */
async function fetchFromCat(code) {
  const response = await superagent
    .get(`https://http.cat/${code}`)
    .buffer(true)
    .parse(superagent.parse.image);
  return response.body;
}

/**
 * Безпечно записує файл на диск.
 * Дані спочатку пишуться у тимчасовий файл, а потім файл
 * перейменовується в кінцеве ім'я. Завдяки цьому клієнт ніколи
 * не прочитає наполовину записаний файл, навіть якщо кілька
 * запитів пишуть одночасно. Якщо запис не вдався, тимчасовий
 * файл видаляється.
 * @param {string} file - кінцевий шлях до файлу
 * @param {Buffer} data - дані для запису
 */
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

/**
 * Обробляє GET: повертає картинку для заданого коду.
 * 1) Якщо файл є в кеші, віддає його (заголовок X-Cache: HIT).
 * 2) Якщо файлу немає (ENOENT), завантажує картинку з http.cat,
 *    зберігає в кеш і віддає (X-Cache: MISS).
 * 3) Якщо http.cat не віддав картинку, відповідає 404
 *    і нічого не зберігає в кеш.
 * Інші помилки файлової системи передаються далі й дають 500.
 * @param {http.ServerResponse} res - об'єкт відповіді
 * @param {number} code - код стану HTTP
 */
async function handleGet(res, code) {
  const file = filePath(code);
  let image;
  let source;

  try {
    image = await fs.readFile(file);
    source = 'HIT'; // влучання в кеш
  } catch (err) {
    if (err.code !== 'ENOENT') throw err; // не "файл не знайдено" -> 500

    // Промах кешу: звертаємося до http.cat.
    try {
      image = await fetchFromCat(code);
    } catch {
      return send(res, 404, 'Картинку не знайдено');
    }
    // Запис стоїть після успішного запиту, тому при помилці кеш не змінюється.
    await saveAtomic(file, image);
    source = 'MISS';
  }

  // X-Cache показує, звідки взято картинку: з кешу чи з http.cat.
  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Content-Length': image.length,
    'X-Cache': source,
  });
  res.end(image);
}

/**
 * Обробляє PUT: записує картинку з тіла запиту в кеш
 * (створює новий файл або замінює наявний).
 * Порожнє тіло відхиляється з кодом 400, щоб у кеш
 * не потрапив порожній файл. Успіх: 201.
 * @param {http.IncomingMessage} req - об'єкт запиту
 * @param {http.ServerResponse} res - об'єкт відповіді
 * @param {number} code - код стану HTTP
 */
async function handlePut(req, res, code) {
  const body = await readBody(req);
  if (body.length === 0) {
    return send(res, 400, 'Порожнє тіло запиту');
  }
  await saveAtomic(filePath(code), body);
  send(res, 201, 'Картинку збережено');
}

/**
 * Обробляє DELETE: видаляє картинку для заданого коду з кешу.
 * Якщо файлу немає, відповідає 404. Успіх: 200.
 * Інші помилки файлової системи передаються далі й дають 500.
 * @param {http.ServerResponse} res - об'єкт відповіді
 * @param {number} code - код стану HTTP
 */
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
// Єдиний колбек у програмі це async-обробник запиту, який
// передається в createServer. Він перевіряє шлях, за методом
// викликає потрібний обробник, а будь-яку помилку перетворює
// на відповідь 500, тож сервер не падає.
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
        // Заголовок Allow повідомляє клієнту, які методи дозволені.
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

// once() повертає проміс, тому колбек для listen не потрібен.
// Якщо запуск не вдався (наприклад, порт зайнятий), проміс відхилиться.
server.listen(portNumber, host);
await once(server, 'listening');
console.log(`Проксі-сервер працює на http://${host}:${portNumber}, кеш: ${path.resolve(cache)}`);