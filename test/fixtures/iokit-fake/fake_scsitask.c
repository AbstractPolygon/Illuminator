// A stand-in for IOKit's SCSITask interfaces (test/lytro-scsi-mac.test.mjs): structs laid out member for member as in Apple's SCSITaskLib.h and
// IOCFPlugIn.h (64-bit), so the C compiler places the methods; QueryInterface takes the UUID by value; a task reading data fills the buffer of
// its scatter-gather entry with the command block's first byte plus the offset, and reports the length as transferred.
#include <stdint.h>
#include <string.h>

typedef struct { uint8_t b[16]; } CFUUIDBytes;
typedef int32_t IOReturn;
typedef unsigned char Boolean;
typedef struct { uint64_t address; uint64_t length; } SCSITaskSGElement;

#define IUNKNOWN_C_GUTS void *_reserved; int32_t (*QueryInterface)(void *thisPointer, CFUUIDBytes iid, void **ppv); \
  uint32_t (*AddRef)(void *thisPointer); uint32_t (*Release)(void *thisPointer)

typedef struct {
  IUNKNOWN_C_GUTS;
  uint16_t version; uint16_t revision;
  Boolean (*IsTaskActive)(void *task);
  IOReturn (*SetTaskAttribute)(void *task, int attr);
  IOReturn (*GetTaskAttribute)(void *task, int *attr);
  IOReturn (*SetCommandDescriptorBlock)(void *task, uint8_t *cdb, uint8_t size);
  uint8_t (*GetCommandDescriptorBlockSize)(void *task);
  IOReturn (*GetCommandDescriptorBlock)(void *task, uint8_t *cdb);
  IOReturn (*SetScatterGatherEntries)(void *task, SCSITaskSGElement *list, uint8_t entries, uint64_t count, uint8_t direction);
  IOReturn (*SetTimeoutDuration)(void *task, uint32_t ms);
  uint32_t (*GetTimeoutDuration)(void *task);
  IOReturn (*SetTaskCompletionCallback)(void *task, void *cb, void *refCon);
  IOReturn (*ExecuteTaskAsync)(void *task);
  IOReturn (*ExecuteTaskSync)(void *task, void *sense, uint32_t *status, uint64_t *count);
  IOReturn (*AbortTask)(void *task);
  IOReturn (*GetSCSIServiceResponse)(void *task, uint32_t *response);
} SCSITaskInterface;

typedef struct {
  IUNKNOWN_C_GUTS;
  uint16_t version; uint16_t revision;
  Boolean (*IsExclusiveAccessAvailable)(void *self);
  IOReturn (*AddCallbackDispatcherToRunLoop)(void *self, void *runLoop);
  void (*RemoveCallbackDispatcherFromRunLoop)(void *self);
  IOReturn (*ObtainExclusiveAccess)(void *self);
  IOReturn (*ReleaseExclusiveAccess)(void *self);
  SCSITaskInterface **(*CreateSCSITask)(void *self);
} SCSITaskDeviceInterface;

static const uint8_t TASK_DEVICE_ID[16] = { 0x1B, 0xBC, 0x41, 0x32, 0x08, 0xA5, 0x11, 0xD5, 0x90, 0xED, 0x00, 0x30, 0x65, 0x7D, 0x05, 0x2A };

static struct { uint8_t cdb[16]; uint8_t cdbSize; uint64_t addr, len, count; uint8_t dir; uint32_t timeout; int exclusive, released, tasks; } st;

static uint32_t task_release(void *t) { (void)t; st.released++; return 0; }
static IOReturn set_cdb(void *t, uint8_t *cdb, uint8_t size) { (void)t; memcpy(st.cdb, cdb, size); st.cdbSize = size; return 0; }
static IOReturn set_sg(void *t, SCSITaskSGElement *l, uint8_t n, uint64_t count, uint8_t dir) { (void)t; if (n != 1) return -1; st.addr = l[0].address; st.len = l[0].length; st.count = count; st.dir = dir; return 0; }
static IOReturn set_timeout(void *t, uint32_t ms) { (void)t; st.timeout = ms; return 0; }
static IOReturn exec_sync(void *t, void *sense, uint32_t *status, uint64_t *count) {
  (void)t; (void)sense;
  if (st.dir == 2) for (uint64_t i = 0; i < st.len; i++) ((uint8_t *)st.addr)[i] = (uint8_t)(st.cdb[0] + i);
  *status = st.cdb[0] == 0x99 ? 2 : 0;
  *count = st.dir ? st.len : 0;
  return 0;
}
static IOReturn service_response(void *t, uint32_t *r) { (void)t; *r = 2; return 0; }

static SCSITaskInterface taskTable = { .Release = task_release, .SetCommandDescriptorBlock = set_cdb, .SetScatterGatherEntries = set_sg,
  .SetTimeoutDuration = set_timeout, .ExecuteTaskSync = exec_sync, .GetSCSIServiceResponse = service_response };
static SCSITaskInterface *taskObj = &taskTable;

static IOReturn obtain(void *self) { (void)self; st.exclusive++; return 0; }
static IOReturn release_ex(void *self) { (void)self; st.exclusive--; return 0; }
static SCSITaskInterface **create_task(void *self) { (void)self; st.tasks++; memset(st.cdb, 0, 16); st.dir = 0; st.len = 0; return &taskObj; }
static SCSITaskDeviceInterface deviceTable = { .ObtainExclusiveAccess = obtain, .ReleaseExclusiveAccess = release_ex, .CreateSCSITask = create_task };
static SCSITaskDeviceInterface *deviceObj = &deviceTable;

static int32_t plugin_qi(void *self, CFUUIDBytes iid, void **ppv) { (void)self; if (memcmp(iid.b, TASK_DEVICE_ID, 16)) { *ppv = 0; return -1; } *ppv = &deviceObj; return 0; }
static struct { IUNKNOWN_C_GUTS; } pluginTable = { .QueryInterface = plugin_qi };
static void *pluginObj = &pluginTable;

void *fake_plugin(void) { return &pluginObj; }
int fake_exclusive(void) { return st.exclusive; }
int fake_tasks_released(void) { return st.released; }
uint32_t fake_timeout(void) { return st.timeout; }
uint8_t fake_cdb_size(void) { return st.cdbSize; }
uint8_t fake_dir(void) { return st.dir; }
uint64_t fake_count(void) { return st.count; }
