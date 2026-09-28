"""Pin Phoenix 20.16.0's otherwise wildcard gRPC listener to loopback."""
from importlib.metadata import distribution

package = distribution("arize-phoenix")
if package.version != "20.16.0":
    raise SystemExit("Revalidate the gRPC binding patch before changing Phoenix versions")
path = package.locate_file("phoenix/server/grpc_server.py")
source = path.read_text()
old = 'f"[::]:{self._port}"'
new = 'f"127.0.0.1:{self._port}"'
if source.count(old) == 2:
    path.write_text(source.replace(old, new))
    print("Phoenix gRPC TLS and plaintext listeners now bind only to loopback")
elif source.count(old) == 0 and source.count(new) == 2:
    print("Phoenix gRPC loopback patch already applied")
else:
    raise SystemExit("Unexpected Phoenix gRPC source; refusing an unverified patch")
