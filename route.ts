import { NextResponse } from "next/server";


// Простая защита от спама: не более 10 заявок в минуту с одного IP
const requests = new Map<string, number[]>();
const RATE_LIMIT = 10;
const WINDOW_MS = 60_000;

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const list = (requests.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= RATE_LIMIT) {
    requests.set(ip, list);
    return true;
  }
  list.push(now);
  requests.set(ip, list);
  return false;
}

function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "local";
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);

    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Неверный запрос" }, { status: 400 });
    }

    // Скрытое поле-ловушка для спам-ботов.
    if (body.website) {
      return NextResponse.json({ ok: true });
    }

    if (isRateLimited(clientIp(request))) {
      return NextResponse.json(
        { error: "Слишком много заявок. Попробуйте через минуту." },
        { status: 429 }
      );
    }

    const name = String(body.name ?? "").trim().slice(0, 100);
    const phone = String(body.phone ?? "").trim().slice(0, 30);
    const comment = String(body.comment ?? "").trim().slice(0, 1000);

    // Поддерживаем model и product для совместимости с разными версиями формы.
    const model = String(body.model ?? body.product ?? "").trim().slice(0, 100);

    if (name.length < 2) {
      return NextResponse.json({ error: "Укажите имя" }, { status: 400 });
    }

    if (phone.replace(/\D/g, "").length < 10) {
      return NextResponse.json(
        { error: "Укажите телефон полностью, например +7 900 000-00-00" },
        { status: 400 }
      );
    }

    const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
    const chatId = process.env.TELEGRAM_CHAT_ID?.trim();

    if (!token || !chatId) {
      console.error("Не заданы TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID в .env.local");
      return NextResponse.json(
        { error: "Заявки временно не принимаются. Позвоните нам." },
        { status: 500 }
      );
    }

    const message = [
      "🆕 Новая заявка с сайта «Бани в Пензе»",
      "",
      `Баня: ${model || "не выбрана (общая заявка)"}`,
      `Имя: ${name}`,
      `Телефон: ${phone}`,
      `Комментарий: ${comment || "—"}`,
    ].join("\n");

    // Локальный лог заявки — удобно отлаживать в консоли сервера
    console.log(`[order] ${new Date().toISOString()} | ${name} | ${phone} | ${model || "-"}`);

    let telegramResponse: Response;
    try {
      // Таймаут 8 секунд, чтобы форма не "висела" вечно при проблемах с сетью
      telegramResponse = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text: message }),
          cache: "no-store",
          signal: AbortSignal.timeout(8000),
        }
      );
    } catch (fetchError) {
      console.error("Сеть/Telegram недоступен:", fetchError);
      return NextResponse.json(
        { error: "Не удалось отправить заявку. Проверьте интернет и попробуйте позже." },
        { status: 502 }
      );
    }

    const telegramResult = await telegramResponse.json().catch(() => null);

    // Telegram иногда отвечает HTTP 200 с полем ok: false.
    if (!telegramResponse.ok || !telegramResult?.ok) {
      console.error("Ошибка Telegram:", telegramResult);
      return NextResponse.json(
        { error: "Не удалось отправить заявку. Попробуйте позже или позвоните нам." },
        { status: 502 }
      );
    }

    return NextResponse.json({
      ok: true,
      message: "Заявка успешно отправлена",
    });
  } catch (error) {
    console.error("Ошибка API заявок:", error);
    return NextResponse.json(
      { error: "Внутренняя ошибка сервера" },
      { status: 500 }
    );
  }
}