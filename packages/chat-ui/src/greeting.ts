const MORNING_STARTS_HOUR = 5
const AFTERNOON_STARTS_HOUR = 12
const EVENING_STARTS_HOUR = 17
const NIGHT_STARTS_HOUR = 22

// How a new chat greets the user by name, for the time of day.
export function timeOfDayGreeting(name: string, now = new Date()): string {
  const hour = now.getHours()
  if (hour >= MORNING_STARTS_HOUR && hour < AFTERNOON_STARTS_HOUR)
    return `Good morning, ${name}!`
  if (hour >= AFTERNOON_STARTS_HOUR && hour < EVENING_STARTS_HOUR)
    return `Good afternoon, ${name}!`
  if (hour >= EVENING_STARTS_HOUR && hour < NIGHT_STARTS_HOUR)
    return `Good evening, ${name}!`
  return `Up late, ${name}?`
}
