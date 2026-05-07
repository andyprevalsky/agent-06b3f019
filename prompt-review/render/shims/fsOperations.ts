export const getFsImplementation = () => ({
      readFile: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
      writeFile: async () => {},
      mkdir: async () => {},
      access: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
      stat: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    });
