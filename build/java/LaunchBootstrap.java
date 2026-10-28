/* LDFCL, MIT license. Independently implemented; see LICENSE.
 * Build with: node scripts/build-java-bootstrap.cjs <path-to-javac>
 * Java 8 bytecode also runs on the newer JVMs used by Minecraft.
 */
package io.ldfcl.launch;

import java.io.DataInputStream;
import java.io.IOException;
import java.lang.reflect.InvocationTargetException;
import java.nio.charset.StandardCharsets;

/** Uses the ordinary system class loader and receives sensitive arguments only
 * through an anonymous pipe. Neither the game token nor the argument payload is
 * written to a command line, environment variable, manifest or temporary file.
 */
public final class LaunchBootstrap {
    private static String string(DataInputStream input) throws IOException {
        int length = input.readInt();
        if (length < 0 || length > 16 * 1024 * 1024) {
            throw new IOException("Invalid LDFCL launch payload");
        }
        byte[] bytes = new byte[length];
        input.readFully(bytes);
        return new String(bytes, StandardCharsets.UTF_8);
    }

    private static int count(DataInputStream input) throws IOException {
        int count = input.readInt();
        if (count < 0 || count > 100000) {
            throw new IOException("Invalid LDFCL launch item count");
        }
        return count;
    }

    public static void main(String[] ignored) throws Throwable {
        DataInputStream input = new DataInputStream(System.in);
        if (input.readInt() != 0x4c444631) {
            throw new IOException("Invalid LDFCL launch protocol");
        }
        String classpath = string(input);
        String mainClass = string(input);
        int properties = count(input);
        for (int index = 0; index < properties; index++) {
            System.setProperty(string(input), string(input));
        }
        int length = count(input);
        String[] arguments = new String[length];
        for (int index = 0; index < length; index++) {
            arguments[index] = string(input);
        }
        // Forge/Fabric and older launch wrappers inspect this property. The
        // actual system class loader already has these same entries through the
        // bootstrap JAR's Class-Path manifest; no custom class loader is used.
        System.setProperty("java.class.path", classpath);
        try {
            Class.forName(mainClass, true, ClassLoader.getSystemClassLoader())
                .getMethod("main", String[].class)
                .invoke(null, (Object) arguments);
        } catch (InvocationTargetException exception) {
            throw exception.getCause();
        }
    }
}
