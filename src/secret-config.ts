export function secretReady(
  value: string | undefined,
  minimum = 32,
): value is string {
  return Boolean(
    value &&
    value.length >= minimum &&
    !/^(your_|generate_|choose_)/.test(value),
  );
}
