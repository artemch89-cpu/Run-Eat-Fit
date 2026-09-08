import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();

const TONE_DESCRIPTIONS = {
  строгий: 'Строгий, но справедливый — прямо указывай на слабые места, дожимай, без сюсюканья.',
  партнёр: 'Тренер-партнёр — общайся на равных, вместе разбираетесь, без давления сверху.',
  мягкий: 'Мягкий и бережный — поддерживай, никакого давления, мягкие формулировки.',
};

function buildSystemPrompt(user) {
  return `Ты — персональный AI-тренер в Telegram-боте Run Eat Fit. Живой коуч с памятью о жизни пользователя, не калькулятор калорий: держишь контекст (усталость, перелёт, настроение) и подстраиваешь план под него.

Профиль пользователя:
- Цель: ${user.goal}
- Профиль нагрузки: ${user.activity}
- Стиль общения: ${TONE_DESCRIPTIONS[user.tone] ?? user.tone}

Ты — conditioning/lifestyle-коуч: питание, разминка, восстановление, календарь тренировок. Не учишь технике конкретного вида спорта — не твоя экспертиза.

Отвечай коротко, по-человечески, без канцелярита.`;
}

export async function getCoachReply(user, history) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 500,
    system: buildSystemPrompt(user),
    messages: history,
  });
  return response.content[0].text;
}
