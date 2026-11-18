import {build} from 'vite';
import {buildExtension} from './build-extension.ts';

if (!process.argv.includes('--extension')) await build();
await buildExtension();
