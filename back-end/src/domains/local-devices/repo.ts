/**
 * Local devices data access: delegates to the shared provider store, which the
 * agent-create and code-session paths also use.
 */
export {
  DeviceOwnedByAnotherUserError,
  listLocalDevices,
  registerLocalDevice,
  type LocalDeviceRecord,
} from '../../providers/localDevices/store';
