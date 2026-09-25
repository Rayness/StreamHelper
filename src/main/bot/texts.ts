import { renderTemplate } from '@shared/template';
import type { Language } from '@shared/types';

const TEXTS = {
  ru: {
    uptime: 'Стрим идёт уже {uptime}',
    offline: 'Стрим сейчас офлайн',
    followage: '{user} отслеживает канал {duration}',
    notFollowing: '{user} не отслеживает канал',
    commands: 'Команды: {list}',
    title: 'Название: {title}',
    titleSet: 'Название изменено: {title}',
    game: 'Категория: {game}',
    gameSet: 'Категория изменена: {game}',
    gameNotFound: 'Категория «{query}» не найдена',
    shoutout: 'Загляните к {name} — twitch.tv/{login}! Последняя категория: {game}',
    shoutoutNoGame: 'Загляните к {name} — twitch.tv/{login}!',
    userNotFound: 'Пользователь {login} не найден',
    counter: 'Счётчик {name}: {value}',
    permit: '@{login}, можешь отправить ссылку в течение {sec} сек.',
    failed: 'Не получилось: {error}',
    animeNone: 'Сейчас ничего не смотрим',
  },
  en: {
    uptime: 'Stream has been live for {uptime}',
    offline: 'The stream is offline',
    followage: '{user} has been following for {duration}',
    notFollowing: '{user} is not following',
    commands: 'Commands: {list}',
    title: 'Title: {title}',
    titleSet: 'Title updated: {title}',
    game: 'Category: {game}',
    gameSet: 'Category updated: {game}',
    gameNotFound: 'Category "{query}" not found',
    shoutout: 'Go check out {name} at twitch.tv/{login}! They were last seen in {game}',
    shoutoutNoGame: 'Go check out {name} at twitch.tv/{login}!',
    userNotFound: 'User {login} not found',
    counter: 'Counter {name}: {value}',
    permit: '@{login}, you may post a link in the next {sec}s',
    failed: 'Failed: {error}',
    animeNone: 'Not watching anything right now',
  },
} satisfies Record<Language, Record<string, string>>;

export type BotTextKey = keyof (typeof TEXTS)['ru'];

export function botText(lang: Language, key: BotTextKey, vars: Record<string, string | number> = {}): string {
  return renderTemplate(TEXTS[lang][key], vars);
}
