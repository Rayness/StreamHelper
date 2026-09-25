declare module 'socket.io-client-v2' {
  interface Socket {
    on(event: string, handler: (...args: any[]) => void): Socket;
    removeAllListeners(): Socket;
    close(): Socket;
    connected: boolean;
  }
  function io(url: string, opts?: Record<string, unknown>): Socket;
  export default io;
}
