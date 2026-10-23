// Entry of the web build: the bridges first, then the very same renderer as the desktop program.
import './web.css';
import { installHost } from './host';

installHost();
void import('../renderer/src/main');
