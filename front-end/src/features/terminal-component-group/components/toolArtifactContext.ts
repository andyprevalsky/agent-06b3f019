import { createContext, useContext } from 'react';
import type { Message } from '../hooks';

export const ToolArtifactContext = createContext<Message[]>([]);
export const useToolArtifacts = () => useContext(ToolArtifactContext);
