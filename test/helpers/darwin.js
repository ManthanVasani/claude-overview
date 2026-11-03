'use strict';

// must load before lib/config reads process.platform: the code then takes this machine for macOS
Object.defineProperty(process, 'platform', { value: 'darwin' });
