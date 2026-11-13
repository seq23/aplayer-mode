// What every build WITHOUT EXPO_PUBLIC_APM_PREVIEW=1 gets in place of ./server.ts
// (metro.config.js): the sample server and its sample data never ship in a store or web build.
export async function previewRequest<T>(_path: string, _options: RequestInit = {}): Promise<T> {
  throw new Error('The preview sample server is not in this build');
}
